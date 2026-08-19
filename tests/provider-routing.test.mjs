import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createRequire } from "node:module";
import { normalizeProviders } from "../app/provider-routing.mjs";

const require = createRequire(import.meta.url);

test("video routing always uses Seedance, including projects saved with OpenAI Video", () => {
  assert.equal(normalizeProviders().video, "Seedance");
  assert.equal(normalizeProviders({ video: "OpenAI Video" }).video, "Seedance");
  assert.equal(normalizeProviders({ storyboard: "自定义兼容服务", image: "OpenAI Image", video: "unknown", voice: "火山语音" }).video, "Seedance");
  assert.equal(normalizeProviders({ video: "本地 ComfyUI" }).video, "本地 ComfyUI");
});

test("settings UI exposes Seedance and the local ComfyUI generator", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /\['video','视频生成',\['Seedance','本地 ComfyUI'\]\]/);
  assert.match(page, /检测 ComfyUI 与工作流/);
  assert.match(page, /导入 API 工作流 JSON/);
  assert.doesNotMatch(page, /\['video','视频生成',\['OpenAI Video'/);
  assert.doesNotMatch(page, /<label>视频模型<\/label><input value=\{appSettings\.openai\.videoModel\}/);
});

test("new OpenAI Video submissions are rejected before a provider request", async () => {
  const providers = require("../desktop/providers.cjs");
  const previousFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls += 1; throw new Error("must not fetch"); };
  try {
    await assert.rejects(
      providers.submitVideoTask({ apiKey: "fake", videoModel: "sora-2" }, { provider: "OpenAI Video", prompt: "test", ratio: "16:9", duration: 4 }),
      /OpenAI Video 已移除.*Seedance/,
    );
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
