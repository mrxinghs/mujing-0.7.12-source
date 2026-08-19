import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { VALID_PNG } from "./image-fixtures.mjs";

const require = createRequire(import.meta.url);
const provider = require("../desktop/comfyui-provider.cjs");
const png = `data:image/png;base64,${VALID_PNG.toString("base64")}`;

test("built-in Wan 2.2 workflow follows the selected project ratio and duration", () => {
  const workflow = provider.patchedWorkflow({ fps: "24", steps: "30" }, { ratio: "9:16", duration: 4, prompt: "人物缓慢回头", shotId: "shot-01" }, "frame.png");
  assert.equal(workflow["55"].inputs.width, 704);
  assert.equal(workflow["55"].inputs.height, 1280);
  assert.equal(workflow["55"].inputs.length % 4, 1);
  assert.equal(workflow["57"].inputs.image, "frame.png");
  assert.equal(workflow["6"].inputs.text, "人物缓慢回头");
});

test("connection test reports the GPU and verifies every workflow node", async () => {
  const required = provider.readWorkflow({});
  const fetch = async (url) => String(url).endsWith("/system_stats")
    ? Response.json({ devices: [{ name: "RTX Test", vram_total: 12 * 1024 ** 3 }] })
    : Response.json(Object.fromEntries(Object.values(required).map((node) => [node.class_type, {}])));
  const result = await provider.testComfyUIConnection({ baseUrl: "http://127.0.0.1:8188" }, { fetch });
  assert.equal(result.gpuName, "RTX Test");
  assert.equal(result.vramGb, 12);
  assert.deepEqual(result.missingNodes, []);
});

test("connection test reports an exact missing Wan model before generation", async () => {
  const required = provider.readWorkflow({});
  const objectInfo = Object.fromEntries(Object.values(required).map((node) => [node.class_type, {}]));
  objectInfo.UNETLoader = { input: { required: { unet_name: [["another-model.safetensors"]] } } };
  const fetch = async (url) => String(url).endsWith("/system_stats") ? Response.json({ devices: [] }) : Response.json(objectInfo);
  await assert.rejects(provider.testComfyUIConnection({ baseUrl: "http://127.0.0.1:8188" }, { fetch }), /wan2\.2_ti2v_5B_fp16\.safetensors.*models\/diffusion_models/);
});

test("local submit uploads the reference image and returns ComfyUI prompt id", async () => {
  const mediaDir = await mkdtemp(path.join(os.tmpdir(), "mujing-comfy-submit-"));
  let submitted;
  const fetch = async (url, init) => {
    if (String(url).endsWith("/upload/image")) return Response.json({ name: "frame.png", subfolder: "", type: "input" });
    if (String(url).endsWith("/prompt")) { submitted = JSON.parse(init.body); return Response.json({ prompt_id: "local-job-1", node_errors: {} }); }
    throw new Error(`unexpected ${url}`);
  };
  try {
    const result = await provider.submitComfyUIVideoTask({ baseUrl: "http://localhost:8188", fps: "16", steps: "20" }, { imageUrl: png, ratio: "16:9", duration: 3, prompt: "轻微推进", shotId: "shot-01" }, mediaDir, { fetch });
    assert.equal(result.jobId, "local-job-1");
    assert.equal(result.provider, "本地 ComfyUI");
    assert.equal(submitted.prompt["55"].inputs.width, 1280);
  } finally { await rm(mediaDir, { recursive: true, force: true }); }
});

test("local poll downloads output and cancel interrupts the queue", async () => {
  const mediaDir = await mkdtemp(path.join(os.tmpdir(), "mujing-comfy-poll-"));
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push([String(url), init.method || "GET"]);
    if (String(url).includes("/history/job-1")) return Response.json({ "job-1": { status: { completed: true, status_str: "success" }, outputs: { "47": { videos: [{ filename: "clip.webm", subfolder: "", type: "output" }] } } } });
    if (String(url).includes("/view?")) return new Response(Buffer.from("fake-video"), { status: 200 });
    return Response.json({});
  };
  try {
    const result = await provider.pollComfyUIVideoTask({ baseUrl: "http://127.0.0.1:8188" }, { jobId: "job-1" }, mediaDir, () => {}, { fetch, probeMediaFile: async (file) => assert.equal(await readFile(file, "utf8"), "fake-video") });
    assert.equal(result.status, "succeeded");
    await provider.cancelComfyUIVideoTask({ baseUrl: "http://127.0.0.1:8188" }, { jobId: "job-1" }, { fetch });
    assert.ok(calls.some(([url]) => url.endsWith("/interrupt")));
    assert.ok(calls.some(([url]) => url.endsWith("/queue")));
  } finally { await rm(mediaDir, { recursive: true, force: true }); }
});

test("local provider refuses non-loopback ComfyUI addresses", () => {
  assert.throws(() => provider.baseUrl({ baseUrl: "http://192.168.1.2:8188" }), /只允许/);
});
