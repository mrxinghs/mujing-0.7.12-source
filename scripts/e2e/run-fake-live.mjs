import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const options = Object.fromEntries(process.argv.slice(2).map((item) => {
  const [key, ...rest] = item.replace(/^--/, "").split("=");
  return [key, rest.join("=")];
}));
const fixturePath = resolve(options.fixture || "tests/fixtures/core-journey-zh.txt");
const evidenceDir = resolve(options.evidence || "e2e-evidence");
await mkdir(evidenceDir, { recursive: true });
const fixture = (await readFile(fixturePath, "utf8")).trim();
const sentences = fixture.split(/(?<=[。！？!?])/).map((item) => item.trim()).filter(Boolean);
const runtimeDir = await mkdtemp(join(os.tmpdir(), "mujing-fake-live-"));
const profileDir = join(runtimeDir, "profile");
const mediaFixtureDir = join(runtimeDir, "provider-media");
await mkdir(profileDir, { recursive: true });
await mkdir(mediaFixtureDir, { recursive: true });

function run(command, args) {
  const result = spawnSync(command, args, { windowsHide: true, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} 失败：${result.stderr?.slice(-1200)}`);
}

function sha(value) { return crypto.createHash("sha256").update(value).digest("hex"); }

const palette = ["264653", "2a9d8f", "e9c46a", "f4a261", "e76f51", "355070", "6d597a", "b56576", "eaac8b", "386641", "6a994e", "a7c957", "bc4749", "1d3557", "457b9d", "e63946"];
const imageBuffers = [];
for (const color of palette) {
  const output = join(mediaFixtureDir, `image-${color}.png`);
  run("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", `color=c=#${color}:s=640x360`, "-frames:v", "1", output]);
  imageBuffers.push(await readFile(output));
}
const videoFixtures = [];
for (const [index, narration] of sentences.entries()) {
  const duration = Math.max(4, Math.min(10, Math.round(narration.length / 4.2)));
  const shotNumber = index + 1;
  const output = join(mediaFixtureDir, `video-shot-${String(shotNumber).padStart(2, "0")}.mp4`);
  const markerX = 24 + (index % 8) * 70;
  const markerY = 24 + Math.floor(index / 8) * 58;
  const movingY = 210 + (index % 4) * 24;
  const videoFilter = `drawbox=x=${markerX}:y=${markerY}:w=44:h=44:color=white:t=fill,drawbox=x=mod(t*${70 + index * 4}\\,520):y=${movingY}:w=120:h=28:color=#${palette[(index + 5) % palette.length]}:t=fill`;
  run("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", `color=c=#${palette[index]}:s=640x360:r=30:d=${duration}`, "-vf", videoFilter, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", output]);
  const bytes = await readFile(output);
  videoFixtures.push({ shotNumber, duration, color: palette[index], markerX, markerY, bytes, sha256: sha(bytes), path: output });
}
const speechPath = join(mediaFixtureDir, "speech.wav");
run("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=22050:duration=60", "-c:a", "pcm_s16le", speechPath]);
const speechBuffer = await readFile(speechPath);

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolvePort(port));
    });
  });
}

const requestLog = [];
const tasks = new Map();
let imageSubmitCount = 0;
let videoSubmitCount = 0;
function record(method, pathname, summary = {}) {
  requestLog.push({ sequence: requestLog.length + 1, at: new Date().toISOString(), method, path: pathname, ...summary });
}

const fakeServer = http.createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks);
  let body = {};
  if (raw.length && String(request.headers["content-type"] || "").includes("application/json")) {
    try { body = JSON.parse(raw.toString("utf8")); } catch { body = {}; }
  }
  const common = { authorizationPresent: Boolean(request.headers.authorization), requestBytes: raw.length };
  if (request.method === "POST" && url.pathname === "/v1/responses") {
    record("POST", url.pathname, { ...common, kind: "storyboard", inputLength: String(body.input || "").length, inputSha256: sha(String(body.input || "")) });
    const shots = sentences.map((narration, index) => ({
      narration,
      duration: Math.max(4, Math.min(10, Math.round(narration.length / 4.2))),
      visual: `Fake Live 画面 ${index + 1}：${narration.replace(/[。！？!?]/g, "")}`,
      shotType: ["全景", "中景", "近景"][index % 3],
      camera: ["缓慢推进", "平稳横移", "轻微环绕"][index % 3],
      imagePrompt: `FAKE_IMAGE_SHOT_${String(index + 1).padStart(2, "0")} ${narration}`,
      videoPrompt: `FAKE_VIDEO_SHOT_${String(index + 1).padStart(2, "0")} 平稳运动`,
    }));
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ output_text: JSON.stringify(shots) }));
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/images/generations") {
    const index = imageSubmitCount++;
    record("POST", url.pathname, { ...common, kind: "image", imageIndex: index + 1, model: body.model, promptSha256: sha(String(body.prompt || "")), promptMarker: /FAKE_IMAGE_SHOT_\d+/.exec(String(body.prompt || ""))?.[0] });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: [{ b64_json: imageBuffers[index % imageBuffers.length].toString("base64") }] }));
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/contents/generations/tasks") {
    const index = ++videoSubmitCount;
    const text = String(body.content?.find((item) => item.type === "text")?.text || "");
    const imageUrl = String(body.content?.find((item) => item.type === "image_url")?.image_url?.url || "");
    const duration = Math.max(4, Math.min(10, Number(/--dur\s+(\d+)/.exec(text)?.[1] || 4)));
    const taskId = `fake-video-${String(index).padStart(2, "0")}`;
    tasks.set(taskId, { index, polls: 0, duration, textSha256: sha(text), firstFrameBytes: Buffer.from(imageUrl.split(",")[1] || "", "base64").length, firstFrameSha256: sha(Buffer.from(imageUrl.split(",")[1] || "", "base64")) });
    record("POST", url.pathname, { ...common, kind: "video-submit", taskId, duration, textSha256: sha(text), promptMarker: /FAKE_VIDEO_SHOT_\d+/.exec(text)?.[0], firstFrameBytes: tasks.get(taskId).firstFrameBytes, firstFrameSha256: tasks.get(taskId).firstFrameSha256 });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ id: taskId, status: "queued" }));
    return;
  }
  const taskMatch = /^\/v1\/contents\/generations\/tasks\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && taskMatch) {
    const taskId = decodeURIComponent(taskMatch[1]);
    const task = tasks.get(taskId);
    if (!task) { response.writeHead(404); response.end(); return; }
    task.polls += 1;
    let status = "succeeded";
    if (task.index === 1 && task.polls === 1) status = "running";
    if (task.index === 2 && task.polls === 1) status = "failed";
    record("GET", url.pathname, { ...common, kind: "video-poll", taskId, poll: task.polls, status });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(status === "succeeded"
      ? { id: taskId, status, content: { video_url: `http://127.0.0.1:${fakeServer.address().port}/media/video-shot-${String(task.index).padStart(2, "0")}.mp4` } }
      : status === "failed" ? { id: taskId, status, error: { message: "Fake provider：镜头 02 首次轮询失败，可恢复原任务" } } : { id: taskId, status }));
    return;
  }
  const mediaMatch = /^\/media\/video-shot-(\d+)\.mp4$/.exec(url.pathname);
  if (request.method === "GET" && mediaMatch) {
    const shotNumber = Number(mediaMatch[1]);
    const fixtureVideo = videoFixtures[shotNumber - 1];
    record("GET", url.pathname, { ...common, kind: "video-download", shotNumber, duration: fixtureVideo.duration, sourceSha256: fixtureVideo.sha256 });
    const bytes = fixtureVideo.bytes;
    response.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": bytes.length });
    response.end(bytes);
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/audio/speech") {
    record("POST", url.pathname, { ...common, kind: "speech", model: body.model, inputLength: String(body.input || "").length, inputSha256: sha(String(body.input || "")), completeFixture: String(body.input || "") === fixture });
    response.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": speechBuffer.length });
    response.end(speechBuffer);
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/models") {
    record("GET", url.pathname, { ...common, kind: "models" });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "fake" }] }));
    return;
  }
  record(request.method, url.pathname, { ...common, kind: "unhandled" });
  response.writeHead(404, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ error: { message: "fake endpoint not found" } }));
});
await new Promise((resolveListen) => fakeServer.listen(0, "127.0.0.1", resolveListen));
const fakePort = fakeServer.address().port;
const debugPort = await freePort();

class CdpClient {
  constructor(url) { this.socket = new WebSocket(url); this.nextId = 1; this.pending = new Map(); }
  async connect() {
    await new Promise((resolveReady, reject) => { this.socket.addEventListener("open", resolveReady, { once: true }); this.socket.addEventListener("error", reject, { once: true }); });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data); const pending = this.pending.get(message.id); if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }
  send(method, params = {}) { const id = this.nextId++; this.socket.send(JSON.stringify({ id, method, params })); return new Promise((resolveResult, reject) => this.pending.set(id, { resolve: resolveResult, reject })); }
  async evaluate(expression) { const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result?.value; }
  close() { this.socket.close(); }
}

async function waitFor(client, expression, label, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const value = await client.evaluate(expression); if (value) return value; await new Promise((resolveWait) => setTimeout(resolveWait, 200)); }
  throw new Error(`等待超时：${label}`);
}
function clickButton(text) {
  return `(() => { const b=[...document.querySelectorAll("button")].find(x=>x.innerText.replace(/\\s+/g,"").includes(${JSON.stringify(text.replace(/\s+/g, ""))})); if(!b) throw new Error("找不到按钮 ${text}"); if(b.disabled) throw new Error("按钮禁用 ${text}"); b.click(); return true; })()`;
}
function setInput(selector, value) {
  return `(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e) throw new Error("找不到输入 ${selector}"); const p=e.tagName==="TEXTAREA"?HTMLTextAreaElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(p,"value").set.call(e,${JSON.stringify(value)}); e.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertText"})); return e.value; })()`;
}
function setInputAt(selector, index, value) {
  return `(() => { const e=document.querySelectorAll(${JSON.stringify(selector)})[${index}]; if(!e) throw new Error("找不到输入 ${selector}[${index}]"); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(e,${JSON.stringify(value)}); e.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertText"})); return e.value; })()`;
}
async function confirmGeneration(client, expectedProvider) {
  await waitFor(client, `document.body.innerText.includes("生成前确认") && document.body.innerText.includes(${JSON.stringify(expectedProvider)})`, `生成确认 ${expectedProvider}`);
  await client.evaluate(`document.querySelector(".generation-notice-modal input[type=checkbox]").click()`);
  await waitFor(client, `!document.querySelector(".generation-notice-modal .primary-inline").disabled`, "确认按钮启用");
  await client.evaluate(clickButton("确认生成"));
}

const outputPath = resolve(evidenceDir, "fake-live-final.mp4");
const electron = spawn(electronPath, [".", `--user-data-dir=${profileDir}`, `--remote-debugging-port=${debugPort}`], { cwd: resolve("."), env: { ...process.env, MUJING_E2E: "1", MUJING_E2E_EXPORT_PATH: outputPath }, windowsHide: false, stdio: ["ignore", "pipe", "pipe"] });
let client;
const trace = [];
try {
  let target;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !target) {
    try { const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json(); target = targets.find((item) => item.type === "page" && /幕境/.test(item.title)); } catch { /* booting */ }
    if (!target) await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  assert.ok(target?.webSocketDebuggerUrl, "Fake Live 隔离 Electron 未启动");
  client = new CdpClient(target.webSocketDebuggerUrl); await client.connect(); await client.send("Runtime.enable");
  await waitFor(client, `document.querySelector("textarea") && document.body.innerText.includes("模型与偏好设置")`, "首页");

  await client.evaluate(clickButton("模型与偏好设置"));
  await waitFor(client, `document.body.innerText.includes("模型与 API 设置")`, "设置窗口");
  await client.evaluate(clickButton("真实模型"));
  const baseUrl = `http://127.0.0.1:${fakePort}/v1`;
  await client.evaluate(setInputAt(".api-provider-card > .api-field.full input", 0, "fake-local-key"));
  await client.evaluate(setInputAt(".api-provider-card > .api-field.full input", 1, baseUrl));
  const openInputs = await client.evaluate(`document.querySelectorAll(".api-provider-card:not(.elevenlabs-card) .api-model-grid input").length`);
  assert.equal(openInputs, 3);
  for (const [index, value] of ["fake-storyboard", "fake-image", "fake-voice"].entries()) await client.evaluate(setInputAt(".api-provider-card:not(.elevenlabs-card) .api-model-grid input", index, value));
  await client.evaluate(`document.querySelector(".custom-api-card").open=true`);
  await client.evaluate(setInputAt(".custom-api-card > .api-field.full input", 0, "fake-local-key"));
  await client.evaluate(setInputAt(".custom-api-card > .api-field.full input", 1, baseUrl));
  const customModels = ["fake-storyboard", "fake-seedream", "fake-seedance", "fake-voice"];
  for (const [index, value] of customModels.entries()) await client.evaluate(setInput(`.custom-api-card .api-model-grid .api-field:nth-child(${index + 1}) input`, value));
  await client.evaluate(clickButton("保存设置"));
  await waitFor(client, `!document.body.innerText.includes("模型与 API 设置") && document.body.innerText.includes("API 设置已加密保存")`, "保存 Fake 设置");

  await client.evaluate(setInput("textarea", fixture));
  await client.evaluate(clickButton("识别角色并继续"));
  await waitFor(client, `document.querySelector('[aria-label="主要角色称呼"]')?.value==="林默" && document.querySelector('[aria-label="第二角色称呼"]')?.value==="苏晴"`, "Fake Live 角色识别");
  await client.evaluate(clickButton("一键锁定主角母版"));
  await confirmGeneration(client, "Seedream");
  await waitFor(client, `(() => { try { return Boolean(JSON.parse(localStorage.getItem("mujing-project-v1")).primaryGeneratedImage); } catch { return false; } })()`, "Fake Live 主角身份母版", 60_000);
  await client.evaluate(clickButton("一键锁定第二角色母版"));
  await confirmGeneration(client, "Seedream");
  await waitFor(client, `(() => { try { return Boolean(JSON.parse(localStorage.getItem("mujing-project-v1")).secondaryGeneratedImage); } catch { return false; } })()`, "Fake Live 第二角色身份母版", 60_000);
  await client.evaluate(clickButton("生成分镜并继续"));
  await confirmGeneration(client, "OpenAI");
  await waitFor(client, `(() => { try { return JSON.parse(localStorage.getItem("mujing-project-v1")).shots.length===${sentences.length}; } catch { return false; } })()`, "Fake storyboard");
  await client.evaluate(clickButton("全部确认"));
  await client.evaluate(clickButton("进入画面生成"));

  await client.evaluate(clickButton("生成全部图片"));
  await confirmGeneration(client, "Seedream");
  await waitFor(client, `(() => { try { const s=JSON.parse(localStorage.getItem("mujing-project-v1")).shots; return s.length===${sentences.length}&&s.every(x=>x.imageState==="ready"); } catch { return false; } })()`, "Fake images");

  await client.evaluate(clickButton("生成全部视频"));
  await confirmGeneration(client, "Seedance");
  await waitFor(client, `(() => { try { const s=JSON.parse(localStorage.getItem("mujing-project-v1")).shots; return s[0].videoState==="ready"&&s[1].videoState==="error"&&!s[1].videoTaskId; } catch { return false; } })()`, "单镜头终态失败且解除任务锁", 60_000);
  trace.push({ stage: "recoverable-failure", project: await client.evaluate(`JSON.parse(localStorage.getItem("mujing-project-v1"))`) });
  await client.evaluate(clickButton("单独重试视频"));
  await confirmGeneration(client, "Seedance");
  await waitFor(client, `(() => { const s=JSON.parse(localStorage.getItem("mujing-project-v1")).shots; return s[1].videoState==="ready"&&s[1].videoTaskId==="fake-video-02"; })()`, "失败后安全恢复原任务成功", 60_000);
  await client.evaluate(clickButton("生成全部视频"));
  await confirmGeneration(client, "Seedance");
  await waitFor(client, `(() => { const s=JSON.parse(localStorage.getItem("mujing-project-v1")).shots; return s.every(x=>x.videoState==="ready"&&x.videoUrl); })()`, "全部 Fake 视频", 120_000);
  await client.evaluate(clickButton("打开时间轴"));
  await client.evaluate(clickButton("生成配音并对齐"));
  await confirmGeneration(client, "OpenAI Voice");
  await waitFor(client, `(() => { const p=JSON.parse(localStorage.getItem("mujing-project-v1")); return Boolean(p.voiceUrl) && p.voiceTimelineAligned === true; })()`, "Fake speech and aligned timeline");
  await client.evaluate(clickButton("导出设置"));
  await waitFor(client, `document.querySelector(".export-modal") && document.body.innerText.includes("可以导出完整成片")`, "完整成片导出窗口");
  await client.evaluate(clickButton("导出完整 MP4"));
  await waitFor(client, `document.body.innerText.includes("完整视频已导出")`, "Fake Live 最终 MP4 导出", 300_000);
  assert.ok((await stat(outputPath)).size > 100_000, "Fake Live 最终 MP4 未生成");
  await new Promise((resolveWait) => setTimeout(resolveWait, 800));
  const project = await client.evaluate(`JSON.parse(localStorage.getItem("mujing-project-v1"))`);
  await writeFile(resolve(evidenceDir, "fake-live-storyboard.json"), `${JSON.stringify(project, null, 2)}\n`, "utf8");
  await writeFile(resolve(evidenceDir, "fake-live-ui-trace.json"), `${JSON.stringify(trace, null, 2)}\n`, "utf8");

  const videoPosts = requestLog.filter((item) => item.kind === "video-submit");
  const polls = requestLog.filter((item) => item.kind === "video-poll");
  assert.equal(videoPosts.length, sentences.length, "每镜头必须且只能 POST 一次");
  assert.equal(new Set(videoPosts.map((item) => item.taskId)).size, sentences.length);
  assert.deepEqual(polls.filter((item) => item.taskId === "fake-video-01").map((item) => item.status), ["running", "succeeded"]);
  assert.deepEqual(polls.filter((item) => item.taskId === "fake-video-02").map((item) => item.status), ["failed", "succeeded"]);
  assert.equal(videoPosts.filter((item) => item.taskId === "fake-video-02").length, 1);
  assert.ok(project.shots.every((shot, index) => shot.videoTaskId === `fake-video-${String(index + 1).padStart(2, "0")}`));
  assert.ok(project.shots.every((shot, index) => shot.imagePrompt.includes(`FAKE_IMAGE_SHOT_${String(index + 1).padStart(2, "0")}`) && shot.videoPrompt.includes(`FAKE_VIDEO_SHOT_${String(index + 1).padStart(2, "0")}`)));
  assert.equal(requestLog.find((item) => item.kind === "speech")?.completeFixture, true);
  const imagePosts = requestLog.filter((item) => item.kind === "image");
  const shotImagePosts = imagePosts.filter((item) => item.promptMarker);
  assert.equal(shotImagePosts.length, sentences.length, "每个分镜必须且只能提交一次图片生成");
  const successfulVideoPosts = project.shots.map((_shot, index) => {
    const marker = `FAKE_VIDEO_SHOT_${String(index + 1).padStart(2, "0")}`;
    return videoPosts.filter((item) => item.promptMarker === marker).at(-1);
  });
  assert.ok(successfulVideoPosts.every(Boolean), "每个镜头都必须能追溯到最终采用的视频请求");
  const bindingReport = {
    passed: true,
    bindings: project.shots.map((shot, index) => ({
      id: shot.id,
      narration: shot.narration,
      visual: shot.visual,
      imagePrompt: shot.imagePrompt,
      videoPrompt: shot.videoPrompt,
      duration: shot.duration,
      characterIds: shot.characterIds,
      image: { url: new URL(shot.imageUrl).pathname, requestSequence: shotImagePosts[index].sequence, promptMarker: shotImagePosts[index].promptMarker },
      video: { url: new URL(shot.videoUrl).pathname, taskId: shot.videoTaskId, provider: shot.videoTaskProvider, requestSequence: successfulVideoPosts[index].sequence, promptMarker: successfulVideoPosts[index].promptMarker, firstFrameSha256: successfulVideoPosts[index].firstFrameSha256 },
    })),
  };
  await writeFile(resolve(evidenceDir, "fake-live-binding-report.json"), `${JSON.stringify(bindingReport, null, 2)}\n`, "utf8");
  const generatedManifestPath = outputPath.replace(/\.mp4$/i, "") + ".render-manifest.json";
  await copyFile(generatedManifestPath, resolve(evidenceDir, "fake-live-render-manifest.json"));
  const shortVideoPath = join(profileDir, "media", "fake-short-video-negative.mp4");
  run("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=320x180:r=30:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", shortVideoPath]);
  const negativeOutput = resolve(evidenceDir, "fake-live-short-video-must-not-exist.mp4");
  await rm(negativeOutput, { force: true });
  const { renderVideo } = require("../../desktop/render.cjs");
  const negativePayload = {
    ...project,
    musicVolume: Number(project.musicVolume ?? 22) / 100,
    shots: project.shots.map((shot, index) => index === 0 ? { ...shot, videoUrl: "http://localhost/__media/fake-short-video-negative.mp4" } : shot),
  };
  await assert.rejects(renderVideo(negativePayload, join(profileDir, "media"), negativeOutput), /镜头 1.*视频.*时长|视频时长.*镜头/);
  assert.equal(await stat(negativeOutput).then(() => true, () => false), false, "短视频负向 E2E 不得产生最终 MP4");
  await writeFile(resolve(evidenceDir, "fake-live-short-video-negative.json"), `${JSON.stringify({ passed: true, sourceDuration: 1, requestedDuration: project.shots[0].duration, outputCreated: false }, null, 2)}\n`, "utf8");

  const raceMediaDir = join(runtimeDir, "race-media");
  const raceReplacementDir = join(runtimeDir, "race-replacements");
  await mkdir(raceMediaDir, { recursive: true });
  await mkdir(raceReplacementDir, { recursive: true });
  const raceVoice = join(raceMediaDir, "race-voice.wav");
  const raceVoiceReplacement = join(raceReplacementDir, "race-voice-880.wav");
  const raceVideoOne = join(raceMediaDir, "race-video-1.mp4");
  const raceVideoTwo = join(raceMediaDir, "race-video-2.mp4");
  const raceVideoReplacement = join(raceReplacementDir, "race-video-2-yellow.mp4");
  run("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=22050:duration=1", "-c:a", "pcm_s16le", raceVoice]);
  run("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=22050:duration=1", "-c:a", "pcm_s16le", raceVoiceReplacement]);
  run("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=30:d=0.5", "-c:v", "libx264", "-pix_fmt", "yuv420p", raceVideoOne]);
  run("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=320x180:r=30:d=0.5", "-c:v", "libx264", "-pix_fmt", "yuv420p", raceVideoTwo]);
  run("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=yellow:s=320x180:r=30:d=0.5", "-c:v", "libx264", "-pix_fmt", "yuv420p", raceVideoReplacement]);
  const originalRaceVoice = await readFile(raceVoice);
  const originalRaceVideoTwo = await readFile(raceVideoTwo);
  const { persistVoiceProvenance } = require("../../desktop/media-provenance.cjs");
  await persistVoiceProvenance({ mediaDir: raceMediaDir, filename: "race-voice.wav", script: "甲乙", source: "fake-live-race" });
  const raceOutput = resolve(evidenceDir, "fake-live-source-replacement-race.mp4");
  const raceResult = await renderVideo({
    script: "甲乙",
    voiceUrl: "http://localhost/__media/race-voice.wav",
    ratio: "16:9",
    shots: [
      { id: "race-1", videoState: "ready", videoUrl: "http://localhost/__media/race-video-1.mp4", narration: "甲", duration: 0.5 },
      { id: "race-2", videoState: "ready", videoUrl: "http://localhost/__media/race-video-2.mp4", narration: "乙", duration: 0.5 },
    ],
  }, raceMediaDir, raceOutput, {
    async onBeforeFfmpegSpawn(boundary) {
      if (boundary.phase === "shot-2") {
        const stagedVideo = boundary.inputs.find((input) => input.role === "shot-2");
        await rename(stagedVideo.path, `${stagedVideo.path}.verified-original`);
        await copyFile(raceVideoReplacement, stagedVideo.path);
      }
      if (boundary.phase === "final-mux") {
        const stagedVoice = boundary.inputs.find((input) => input.role === "voice");
        await rename(stagedVoice.path, `${stagedVoice.path}.verified-original`);
        await copyFile(raceVoiceReplacement, stagedVoice.path);
      }
    },
  });
  const raceManifest = JSON.parse(await readFile(raceResult.manifestPath, "utf8"));
  assert.equal(raceManifest.voice.inputAudioSha256, sha(originalRaceVoice));
  assert.equal(raceManifest.shots[1].inputVideoSha256, sha(originalRaceVideoTwo));
  assert.doesNotMatch(JSON.stringify(raceManifest), /render-jobs|staged/i);
  const racePixelResult = spawnSync("ffmpeg", ["-v", "error", "-ss", "0.75", "-i", raceOutput, "-vf", "scale=1:1:flags=area,format=rgb24", "-frames:v", "1", "-f", "rawvideo", "-"], { windowsHide: true, encoding: null, maxBuffer: 1024 * 1024 });
  assert.equal(racePixelResult.status, 0, String(racePixelResult.stderr));
  const raceSecondPixel = [...Buffer.from(racePixelResult.stdout).subarray(0, 3)];
  assert.ok(raceSecondPixel[0] > 150 && raceSecondPixel[1] < 100 && raceSecondPixel[2] < 100, `race second shot did not retain staged red bytes: ${raceSecondPixel}`);
  const raceAudioResult = spawnSync("ffmpeg", ["-v", "error", "-i", raceOutput, "-map", "0:a:0", "-ac", "1", "-ar", "22050", "-f", "s16le", "-"], { windowsHide: true, encoding: null, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(raceAudioResult.status, 0, String(raceAudioResult.stderr));
  const racePcm = Buffer.from(raceAudioResult.stdout);
  let raceCrossings = 0;
  let previousSample = racePcm.readInt16LE(0);
  for (let offset = 2; offset + 1 < racePcm.length; offset += 2) {
    const sample = racePcm.readInt16LE(offset);
    if ((previousSample < 0 && sample >= 0) || (previousSample >= 0 && sample < 0)) raceCrossings += 1;
    previousSample = sample;
  }
  const raceFrequencyHz = raceCrossings / 2 / (racePcm.length / 2 / 22050);
  assert.ok(raceFrequencyHz < 650, `race audio did not retain staged 440 Hz bytes: ${raceFrequencyHz}`);
  assert.deepEqual(await readdir(join(raceMediaDir, "render-jobs")), []);
  await writeFile(resolve(evidenceDir, "fake-live-source-replacement-race.json"), `${JSON.stringify({
    passed: true,
    policy: "opened-verified-descriptor-wins",
    replacementsAppliedAtSpawnBoundary: ["shot-2-video", "voice"],
    manifestVoiceSha256: raceManifest.voice.inputAudioSha256,
    originalVoiceSha256: sha(originalRaceVoice),
    manifestShot2Sha256: raceManifest.shots[1].inputVideoSha256,
    originalShot2Sha256: sha(originalRaceVideoTwo),
    finalShot2AverageRgb: raceSecondPixel,
    finalAudioEstimatedFrequencyHz: raceFrequencyHz,
    manifestLeaksRenderJobPath: false,
    renderJobEntriesAfterCompletion: 0,
  }, null, 2)}\n`, "utf8");
  run(process.execPath, [
    "scripts/e2e/verify-fake-live-output.mjs",
    `--video=${outputPath}`,
    `--fixture=${fixturePath}`,
    `--project=${resolve(evidenceDir, "fake-live-storyboard.json")}`,
    `--manifest=${generatedManifestPath}`,
    `--sources=${mediaFixtureDir}`,
    `--evidence=${evidenceDir}`,
  ]);
  const journalText = await readFile(join(profileDir, "paid-video-tasks.json"), "utf8");
  await writeFile(resolve(evidenceDir, "fake-live-paid-task-journal.json"), journalText, "utf8");
  const report = {
    passed: true,
    fakeBaseUrl: baseUrl,
    shots: sentences.length,
    imagePosts: shotImagePosts.length,
    characterMasterImagePosts: imagePosts.length - shotImagePosts.length,
    videoPosts: videoPosts.length,
    successfulShotsReposted: false,
    runningThenCompletedTask: "fake-video-01",
    failedThenRecoveredOriginalTask: "fake-video-02",
    recoveredTaskGetStatuses: ["failed", "succeeded"],
    speechCoveredFullFixture: true,
    finalMp4: "fake-live-final.mp4",
    finalMp4Bytes: (await stat(outputPath)).size,
    renderManifest: "fake-live-render-manifest.json",
    allSixteenShotMidpointsVerified: true,
    allSixteenSourceDurationsVerified: true,
    trustedVoiceScriptHashVerified: true,
    trustedVoiceDurationVerified: true,
    shortVideoNegativeBlockedWithZeroOutput: true,
    spawnBoundaryReplacementUsesOpenedVerifiedDescriptors: true,
    allShotsReady: project.shots.every((shot) => shot.imageState === "ready" && shot.videoState === "ready"),
    paidTaskJournalExists: await stat(join(profileDir, "paid-video-tasks.json")).then(() => true, () => false),
  };
  await writeFile(resolve(evidenceDir, "fake-live-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(JSON.stringify(report));
} finally {
  await writeFile(resolve(evidenceDir, "fake-provider-requests.json"), `${JSON.stringify(requestLog, null, 2)}\n`, "utf8");
  client?.close();
  await new Promise((resolveClose) => fakeServer.close(resolveClose));
  if (!electron.killed) electron.kill();
  await new Promise((resolveExit) => { const timer = setTimeout(resolveExit, 3000); electron.once("exit", () => { clearTimeout(timer); resolveExit(); }); });
  await rm(runtimeDir, { recursive: true, force: true });
}
