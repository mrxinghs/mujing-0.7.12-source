import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import test from "node:test";

const require = createRequire(import.meta.url);

function wavBuffer(frequency, seconds = 2) {
  const sampleRate = 8000;
  const samples = sampleRate * seconds;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index += 1) buffer.writeInt16LE(Math.round(Math.sin((index / sampleRate) * Math.PI * 2 * frequency) * 5000), 44 + index * 2);
  return buffer;
}

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(new Request("http://localhost/", { headers: { accept: "text/html" } }), {}, { waitUntil() {}, passThroughOnException() {} });
}

test("server renders the MuJing desktop shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /幕境 · AI 视频创作工作台/);
  assert.match(html, /正在恢复项目/);
  assert.match(html, /从解说文稿到完整成片/);
  assert.doesNotMatch(html, /Your site is taking shape|Building your site/);
});

test("keeps the complete creation workflow wired", async () => {
  const [page, characterInference, main, preload, providers, renderer, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/character-inference.mjs", import.meta.url), "utf8"),
    readFile(new URL("../desktop/main.cjs", import.meta.url), "utf8"),
    readFile(new URL("../desktop/preload.cjs", import.meta.url), "utf8"),
    readFile(new URL("../desktop/providers.cjs", import.meta.url), "utf8"),
    readFile(new URL("../desktop/render.cjs", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(page, /project-name-input/);
  assert.doesNotMatch(page, /window\.prompt/);
  assert.match(page, /模型与 API 设置/);
  assert.match(page, /generateVoice/);
  assert.match(page, /exportMp4/);
  assert.match(page, /createImage/);
  assert.match(page, /submitVideoTask/);
  assert.match(page, /pollVideoTask/);
  assert.match(page, /name: "动漫风格"/);
  assert.match(page, /chooseMusic/);
  assert.match(page, /musicVolume/);
  assert.match(page, /inferPrimaryCharacterProfile/);
  assert.match(page, /inferSecondaryCharacterName/);
  assert.match(characterInference, /return "叙述者"/);
  assert.match(characterInference, /ROLE_WORDS/);
  assert.match(page, /resolvedSecondaryEnabled/);
  assert.match(page, /referencedCharactersForShot/);
  assert.match(page, /缺少母版时系统会阻止生成/);
  assert.match(page, /已全部确认 ✓/);
  assert.match(page, /secondaryCharacterEnabled \? "已启用" : "未启用"/);
  assert.match(main, /safeStorage\.encryptString/);
  assert.match(main, /media:choose-music/);
  assert.match(main, /project:export-video/);
  assert.match(preload, /contextBridge\.exposeInMainWorld/);
  assert.match(preload, /chooseMusic/);
  assert.match(providers, /\/images\/generations/);
  assert.match(providers, /\/contents\/generations\/tasks/);
  assert.match(providers, /\/audio\/speech/);
  assert.match(renderer, /libx264/);
  assert.match(renderer, /mov_text/);
  assert.match(renderer, /amix=inputs=2/);
  assert.match(packageJson, /ffmpeg-static/);
});

test("packaged renderer is present when a desktop build exists", async () => {
  const unpacked = new URL("../release/win-unpacked/", import.meta.url);
  try {
    await access(unpacked);
  } catch {
    return;
  }
  const details = await stat(new URL("resources/ffmpeg.exe", unpacked));
  assert.ok(details.size > 10_000_000);
  const probeDetails = await stat(new URL("resources/ffprobe.exe", unpacked));
  assert.ok(probeDetails.size > 10_000_000);
});

test("renderer mixes replacement music with narration", { timeout: 30_000 }, async () => {
  const mediaDir = await mkdtemp(join(tmpdir(), "mujing-music-test-"));
  const outputPath = join(mediaDir, "music-mix.mp4");
  try {
    const { renderVideo } = require("../desktop/render.cjs");
    const { persistVoiceProvenance } = require("../desktop/media-provenance.cjs");
    const ffmpeg = require("ffmpeg-static");
    const sourceVideo = join(mediaDir, "source-video.mp4");
    await writeFile(join(mediaDir, "voice.wav"), wavBuffer(440));
    await writeFile(join(mediaDir, "music.wav"), wavBuffer(220));
    await persistVoiceProvenance({ mediaDir, filename: "voice.wav", script: "音乐混音测试", source: "test" });
    const created = spawnSync(ffmpeg, ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", sourceVideo], { windowsHide: true });
    assert.equal(created.status, 0, created.stderr?.toString());
    await renderVideo({
      ratio: "16:9",
      script: "音乐混音测试",
      voiceUrl: "http://localhost/__media/voice.wav",
      musicUrl: "http://localhost/__media/music.wav",
      musicVolume: 0.24,
      shots: [{ id: "shot-01", narration: "音乐混音测试", duration: 2, start: 0, end: 2, videoState: "ready", videoUrl: "http://localhost/__media/source-video.mp4" }],
    }, mediaDir, outputPath);
    assert.ok((await stat(outputPath)).size > 10_000);
    const probe = spawnSync(ffmpeg, ["-v", "error", "-i", outputPath, "-map", "0:a:0", "-t", "0.1", "-f", "null", "-"], { windowsHide: true });
    assert.equal(probe.status, 0, probe.stderr?.toString());
  } finally {
    await rm(mediaDir, { recursive: true, force: true });
  }
});
