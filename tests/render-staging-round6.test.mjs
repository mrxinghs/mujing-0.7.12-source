import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { copyFile, mkdtemp, readFile, readdir, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { renderVideo, _test: renderTest } = require("../desktop/render.cjs");
const { persistVoiceProvenance } = require("../desktop/media-provenance.cjs");
const ffmpeg = require("ffmpeg-static");

function run(args, options = {}) {
  const encoding = Object.hasOwn(options, "encoding") ? options.encoding : "utf8";
  const result = spawnSync(ffmpeg, args, { windowsHide: true, encoding, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, String(result.stderr));
  return result;
}

function sha256(buffer) { return crypto.createHash("sha256").update(buffer).digest("hex"); }

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mujing-render-stage-"));
  const mediaDir = path.join(directory, "media");
  fs.mkdirSync(mediaDir, { recursive: true });
  const files = {
    voice: path.join(mediaDir, "voice.wav"),
    voiceReplacement: path.join(directory, "voice-replacement.wav"),
    video1: path.join(mediaDir, "video-1.mp4"),
    video2: path.join(mediaDir, "video-2.mp4"),
    video2Replacement: path.join(directory, "video-2-replacement.mp4"),
    music: path.join(mediaDir, "music.wav"),
    musicReplacement: path.join(directory, "music-replacement.wav"),
  };
  run(["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=22050:duration=1", "-c:a", "pcm_s16le", files.voice]);
  run(["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=22050:duration=1", "-c:a", "pcm_s16le", files.voiceReplacement]);
  run(["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=30:d=0.5", "-c:v", "libx264", "-pix_fmt", "yuv420p", files.video1]);
  run(["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=320x180:r=30:d=0.5", "-c:v", "libx264", "-pix_fmt", "yuv420p", files.video2]);
  run(["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=yellow:s=320x180:r=30:d=0.5", "-c:v", "libx264", "-pix_fmt", "yuv420p", files.video2Replacement]);
  run(["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=22050:duration=1", "-c:a", "pcm_s16le", files.music]);
  run(["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=1760:sample_rate=22050:duration=1", "-c:a", "pcm_s16le", files.musicReplacement]);
  const script = "甲乙";
  await persistVoiceProvenance({ mediaDir, filename: "voice.wav", script, source: "race-test" });
  return { directory, mediaDir, files, script };
}

function payload(value) {
  return {
    script: value.script,
    voiceUrl: "http://localhost/__media/voice.wav",
    musicUrl: "http://localhost/__media/music.wav",
    musicVolume: 0.2,
    ratio: "16:9",
    shots: [
      { id: "one", videoState: "ready", videoUrl: "http://localhost/__media/video-1.mp4", narration: "甲", duration: 0.5 },
      { id: "two", videoState: "ready", videoUrl: "http://localhost/__media/video-2.mp4", narration: "乙", duration: 0.5 },
    ],
  };
}

async function replacePathname(filename, replacement) {
  const displaced = `${filename}.verified-original`;
  await rename(filename, displaced);
  await copyFile(replacement, filename);
}

function pixelAt(video, seconds) {
  const result = run(["-v", "error", "-ss", String(seconds), "-i", video, "-vf", "scale=1:1:flags=area,format=rgb24", "-frames:v", "1", "-f", "rawvideo", "-"], { encoding: null });
  return Buffer.from(result.stdout).subarray(0, 3);
}

function audioFrequency(video) {
  const result = run(["-v", "error", "-i", video, "-map", "0:a:0", "-ac", "1", "-ar", "22050", "-f", "s16le", "-"], { encoding: null });
  const pcm = Buffer.from(result.stdout);
  let crossings = 0;
  let previous = pcm.readInt16LE(0);
  for (let offset = 2; offset + 1 < pcm.length; offset += 2) {
    const sample = pcm.readInt16LE(offset);
    if ((previous < 0 && sample >= 0) || (previous >= 0 && sample < 0)) crossings += 1;
    previous = sample;
  }
  return crossings / 2 / (pcm.length / 2 / 22050);
}

test("post-staging replacement cannot change ffmpeg bytes or manifest hashes", { timeout: 120_000 }, async () => {
  const value = await fixture();
  const output = path.join(value.directory, "race-output.mp4");
  const originalVoice = await readFile(value.files.voice);
  const originalSecondVideo = await readFile(value.files.video2);
  let hookCalled = false;
  try {
    const result = await renderVideo(payload(value), value.mediaDir, output, {
      async onAfterStaging(staged) {
        hookCalled = true;
        assert.ok(staged.voice.path.includes("render-jobs"));
        await copyFile(value.files.voiceReplacement, value.files.voice);
        await copyFile(value.files.video2Replacement, value.files.video2);
      },
    });
    assert.equal(hookCalled, true);
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    assert.equal(manifest.voice.inputAudioSha256, sha256(originalVoice));
    assert.equal(manifest.shots[1].inputVideoSha256, sha256(originalSecondVideo));
    assert.doesNotMatch(JSON.stringify(manifest), /render-jobs|staged/i);
    const secondPixel = pixelAt(output, 0.75);
    assert.ok(secondPixel[0] > 150 && secondPixel[1] < 100 && secondPixel[2] < 100, `second shot should remain red: ${[...secondPixel]}`);
    assert.ok(audioFrequency(output) < 650, "audio should remain the staged 440 Hz voice");
    assert.deepEqual(await readdir(path.join(value.mediaDir, "render-jobs")), []);
  } finally { await rm(value.directory, { recursive: true, force: true }); }
});

test("spawn-boundary pathname replacement cannot change shot, voice, or music bytes consumed by ffmpeg", { timeout: 120_000 }, async () => {
  const value = await fixture();
  const output = path.join(value.directory, "spawn-boundary-race-output.mp4");
  const originals = {
    voice: await readFile(value.files.voice),
    video: await readFile(value.files.video2),
    music: await readFile(value.files.music),
  };
  const replaced = new Set();
  try {
    const result = await renderVideo(payload(value), value.mediaDir, output, {
      async onBeforeFfmpegSpawn(boundary) {
        if (boundary.phase === "shot-2" && !replaced.has("video")) {
          await replacePathname(boundary.inputs[0].path, value.files.video2Replacement);
          replaced.add("video");
        }
        if (boundary.phase === "music-normalize") {
          const music = boundary.inputs.find((input) => input.role === "music");
          if (music && !replaced.has("music")) {
            await replacePathname(music.path, value.files.musicReplacement);
            replaced.add("music");
          }
        }
        if (boundary.phase === "final-mux") {
          const voice = boundary.inputs.find((input) => input.role === "voice");
          if (voice && !replaced.has("voice")) {
            await replacePathname(voice.path, value.files.voiceReplacement);
            replaced.add("voice");
          }
        }
      },
    });
    assert.deepEqual([...replaced].sort(), ["music", "video", "voice"]);
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    assert.equal(manifest.shots[1].inputVideoSha256, sha256(originals.video));
    assert.equal(manifest.voice.inputAudioSha256, sha256(originals.voice));
    assert.equal(manifest.music.inputAudioSha256, sha256(originals.music));
    const secondPixel = pixelAt(output, 0.75);
    assert.ok(secondPixel[0] > 150 && secondPixel[1] < 100 && secondPixel[2] < 100, `replacement yellow frame must not be consumed: ${[...secondPixel]}`);
    assert.ok(audioFrequency(output) < 700, "replacement high-frequency voice/music must not be consumed");
    assert.deepEqual(await readdir(path.join(value.mediaDir, "render-jobs")), []);
  } finally { await rm(value.directory, { recursive: true, force: true }); }
});

test("source mutation during descriptor copy fails closed and removes partial stage", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mujing-stage-copy-race-"));
  const mediaDir = path.join(directory, "media");
  const jobDir = path.join(mediaDir, "render-jobs", "test-job");
  fs.mkdirSync(jobDir, { recursive: true, mode: 0o700 });
  const source = path.join(mediaDir, "large.mp4");
  fs.writeFileSync(source, Buffer.alloc(256 * 1024, 7));
  try {
    await assert.rejects(renderTest.stageControlledMedia({
      mediaDir,
      mediaUrl: "http://localhost/__media/large.mp4",
      jobDir,
      label: "测试视频",
      maxBytes: 1024 * 1024,
      chunkBytes: 64 * 1024,
      async onChunk({ chunkIndex }) {
        if (chunkIndex === 0) fs.appendFileSync(source, Buffer.from([8]));
      },
    }), /复制期间.*变化|源文件.*变化/);
    assert.deepEqual(await readdir(jobDir), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("deleted staged media fails closed and render job is cleaned", { timeout: 120_000 }, async () => {
  const value = await fixture();
  const output = path.join(value.directory, "deleted-stage-must-not-exist.mp4");
  try {
    await assert.rejects(renderVideo(payload(value), value.mediaDir, output, {
      async onAfterStaging(staged) { await rm(staged.shots[1].path, { force: true }); },
    }), /staged|暂存|渲染源.*变化|不可用/);
    assert.equal(fs.existsSync(output), false);
    assert.deepEqual(await readdir(path.join(value.mediaDir, "render-jobs")), []);
  } finally { await rm(value.directory, { recursive: true, force: true }); }
});

test("modified staged media fails closed and render job is cleaned", { timeout: 120_000 }, async () => {
  const value = await fixture();
  const output = path.join(value.directory, "modified-stage-must-not-exist.mp4");
  try {
    await assert.rejects(renderVideo(payload(value), value.mediaDir, output, {
      async onAfterStaging(staged) { fs.appendFileSync(staged.shots[1].path, Buffer.from("tamper")); },
    }), /暂存副本.*变化|渲染源.*变化/);
    assert.equal(fs.existsSync(output), false);
    assert.deepEqual(await readdir(path.join(value.mediaDir, "render-jobs")), []);
  } finally { await rm(value.directory, { recursive: true, force: true }); }
});
