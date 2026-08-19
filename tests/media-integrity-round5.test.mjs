import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { renderVideo, validateCompleteRenderPayload } = require("../desktop/render.cjs");

function runFfmpeg(args) {
  const result = spawnSync("ffmpeg", ["-y", "-v", "error", ...args], { windowsHide: true, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function normalizeScript(value) {
  return String(value || "").normalize("NFKC").replace(/\r\n?/g, "\n").trim();
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function probeDuration(filename, streamType) {
  const selector = streamType === "audio" ? "a:0" : "v:0";
  const result = spawnSync("ffprobe", ["-v", "error", "-select_streams", selector, "-show_entries", "stream=duration", "-of", "json", filename], { windowsHide: true, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return Number(JSON.parse(result.stdout).streams[0].duration);
}

async function createFixture({ voiceDuration = 4, videoDuration = 4, script = "新的四秒文稿。" } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mujing-media-integrity-"));
  const mediaDir = path.join(directory, "media");
  fs.mkdirSync(mediaDir, { recursive: true });
  const voicePath = path.join(mediaDir, "voice.wav");
  const videoPath = path.join(mediaDir, "video.mp4");
  runFfmpeg(["-f", "lavfi", "-i", `sine=frequency=440:sample_rate=22050:duration=${voiceDuration}`, "-c:a", "pcm_s16le", voicePath]);
  runFfmpeg(["-f", "lavfi", "-i", `color=c=blue:s=320x180:r=30:d=${videoDuration}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", videoPath]);
  return { directory, mediaDir, voicePath, videoPath, script };
}

async function writeVoiceIndex(fixture, boundScript) {
  const voiceBytes = await readFile(fixture.voicePath);
  const entry = {
    mediaId: "voice.wav",
    relativePath: "voice.wav",
    kind: "voice",
    scriptSha256: sha256(Buffer.from(normalizeScript(boundScript), "utf8")),
    fileSha256: sha256(voiceBytes),
    duration: probeDuration(fixture.voicePath, "audio"),
    source: "test-fixture",
    createdAt: new Date(0).toISOString(),
  };
  await writeFile(path.join(fixture.mediaDir, "media-provenance.json"), `${JSON.stringify({ version: 1, voice: { "voice.wav": entry } }, null, 2)}\n`, "utf8");
}

function payload(fixture) {
  return {
    script: fixture.script,
    voiceUrl: "http://localhost/__media/voice.wav",
    ratio: "16:9",
    shots: [{ id: "shot-01", videoState: "ready", videoUrl: "http://localhost/__media/video.mp4", narration: fixture.script, duration: 4, start: 0, end: 4 }],
  };
}

test("old 0.5s speech bound to another script is rejected before output instead of being padded", async () => {
  const fixture = await createFixture({ voiceDuration: 0.5 });
  const output = path.join(fixture.directory, "must-not-exist.mp4");
  try {
    await writeVoiceIndex(fixture, "旧文稿。");
    await assert.rejects(renderVideo(payload(fixture), fixture.mediaDir, output), /配音.*文稿|重新生成配音/);
    assert.equal(fs.existsSync(output), false);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("voice replacement after provenance was recorded fails closed", async () => {
  const fixture = await createFixture();
  const output = path.join(fixture.directory, "must-not-exist.mp4");
  try {
    await writeVoiceIndex(fixture, fixture.script);
    runFfmpeg(["-f", "lavfi", "-i", "sine=frequency=880:sample_rate=22050:duration=4", "-c:a", "pcm_s16le", fixture.voicePath]);
    await assert.rejects(renderVideo(payload(fixture), fixture.mediaDir, output), /配音文件.*替换|字节.*变化|重新生成配音/);
    assert.equal(fs.existsSync(output), false);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("one-second provider video cannot claim a four-second shot", async () => {
  const fixture = await createFixture({ videoDuration: 1 });
  const output = path.join(fixture.directory, "must-not-exist.mp4");
  try {
    await writeVoiceIndex(fixture, fixture.script);
    await assert.rejects(renderVideo(payload(fixture), fixture.mediaDir, output), /镜头 1.*视频.*时长|视频时长.*镜头/);
    assert.equal(fs.existsSync(output), false);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("complete export rejects a 16 MiB voice data URL before decoding or creating a render job", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mujing-export-data-url-"));
  const mediaDir = path.join(directory, "media");
  fs.mkdirSync(mediaDir, { recursive: true });
  const hugeEncoded = "A".repeat(Math.ceil((16 * 1024 * 1024) / 3) * 4);
  try {
    assert.throws(() => validateCompleteRenderPayload({
      script: "文稿。",
      voiceUrl: `data:audio/wav;base64,${hugeEncoded}`,
      shots: [{ id: "shot-01", videoState: "ready", videoUrl: "http://localhost/__media/video.mp4", narration: "文稿。", duration: 4 }],
    }), /data URL|受控媒体/);
    assert.equal(fs.existsSync(path.join(mediaDir, "render-jobs")), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("voice provenance survives a module restart and contains no API key", async () => {
  const fixture = await createFixture();
  const modulePath = require.resolve("../desktop/media-provenance.cjs");
  try {
    const firstProcess = require(modulePath);
    const recorded = await firstProcess.persistVoiceProvenance({
      mediaDir: fixture.mediaDir,
      filename: "voice.wav",
      script: fixture.script,
      source: "provider-speech",
      apiKey: "TEST_API_KEY_MUST_NOT_PERSIST",
    });
    delete require.cache[modulePath];
    const restartedProcess = require(modulePath);
    const verified = await restartedProcess.verifyVoiceProvenance({ mediaDir: fixture.mediaDir, filename: "voice.wav", script: fixture.script });
    assert.equal(verified.entry.mediaId, recorded.mediaId);
    assert.equal(verified.entry.scriptSha256, recorded.scriptSha256);
    assert.ok(Math.abs(verified.duration - 4) <= 0.05);
    const indexText = await readFile(path.join(fixture.mediaDir, "media-provenance.json"), "utf8");
    assert.doesNotMatch(indexText, /TEST_API_KEY_MUST_NOT_PERSIST/);
  } finally {
    delete require.cache[modulePath];
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
