import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const require = createRequire(import.meta.url);
const { renderVideo, validateCompleteRenderPayload } = require("../desktop/render.cjs");
const { persistVoiceProvenance } = require("../desktop/media-provenance.cjs");
const ffmpeg = require("ffmpeg-static");

const completePayload = {
  script: "第一句。第二句。",
  voiceUrl: "http://localhost/__media/voice.wav",
  shots: [
    { id: "shot-01", videoState: "ready", videoUrl: "http://localhost/__media/video-01.mp4", narration: "第一句。", duration: 4, start: 0, end: 4 },
    { id: "shot-02", videoState: "ready", videoUrl: "http://localhost/__media/video-02.mp4", narration: "第二句。", duration: 5, start: 4, end: 9 },
  ],
};

function generate(filename, input, outputArgs) {
  const result = spawnSync(ffmpeg, ["-y", "-v", "error", "-f", "lavfi", "-i", input, ...outputArgs, filename], { windowsHide: true });
  assert.equal(result.status, 0, result.stderr?.toString());
}

test("main-process complete render validation fails closed for every missing prerequisite", () => {
  assert.throws(() => validateCompleteRenderPayload({ ...completePayload, shots: [{ ...completePayload.shots[0], videoUrl: "" }, completePayload.shots[1]] }), /镜头 1.*视频或分镜图片/);
  assert.throws(() => validateCompleteRenderPayload({ ...completePayload, shots: [completePayload.shots[0], { ...completePayload.shots[1], videoState: "generating" }] }), /镜头 2.*视频或分镜图片/);
  assert.doesNotThrow(() => validateCompleteRenderPayload({ ...completePayload, shots: [{ ...completePayload.shots[0], videoState: "error", videoUrl: "", imageState: "ready", imageUrl: "http://localhost/__media/frame.jpg" }, completePayload.shots[1]] }));
  assert.throws(() => validateCompleteRenderPayload({ ...completePayload, voiceUrl: "" }), /完整配音/);
  assert.throws(() => validateCompleteRenderPayload({ ...completePayload, shots: [{ ...completePayload.shots[0], narration: "缺字。" }, completePayload.shots[1]] }), /字幕.*完整覆盖/);
  assert.doesNotThrow(() => validateCompleteRenderPayload(completePayload));
});

test("static image fallback renders a 100%-to-103% push-in while real video remains untouched", { timeout: 30_000 }, async () => {
  const mediaDir = await mkdtemp(join(tmpdir(), "mujing-static-image-export-"));
  try {
    generate(join(mediaDir, "voice.wav"), "sine=frequency=440:sample_rate=22050:duration=3", ["-c:a", "pcm_s16le"]);
    generate(join(mediaDir, "frame.jpg"), "color=c=blue:s=320x180", ["-frames:v", "1", "-q:v", "2"]);
    const payload = {
      ratio: "16:9",
      script: "图片镜头。",
      voiceUrl: "http://localhost/__media/voice.wav",
      shots: [{ id: "shot-image", narration: "图片镜头。", duration: 3, start: 0, end: 3, videoState: "error", videoUrl: "", imageState: "ready", imageUrl: "http://localhost/__media/frame.jpg" }],
    };
    await persistVoiceProvenance({ mediaDir, filename: "voice.wav", script: payload.script, source: "test" });
    const output = join(mediaDir, "static-output.mp4");
    const result = await renderVideo(payload, mediaDir, output);
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    assert.deepEqual(manifest.shots[0].staticImageZoom, { from: 1, to: 1.03 });
    assert.equal(manifest.shots[0].visualKind, "image");
    assert.equal(fs.existsSync(output), true);
  } finally { await rm(mediaDir, { recursive: true, force: true }); }
});

test("renderer verifies that non-empty video and voice URLs resolve to usable controlled files", async () => {
  const mediaDir = await mkdtemp(join(tmpdir(), "mujing-complete-export-"));
  try {
    generate(join(mediaDir, "voice.wav"), "sine=frequency=440:sample_rate=22050:duration=4", ["-c:a", "pcm_s16le"]);
    generate(join(mediaDir, "video-01.mp4"), "color=c=blue:s=320x180:r=30:d=4", ["-c:v", "libx264", "-pix_fmt", "yuv420p"]);
    const oneShot = {
      script: "第一句。",
      voiceUrl: "http://localhost/__media/voice.wav",
      shots: [{ ...completePayload.shots[0], narration: "第一句。", videoUrl: "http://localhost/__media/missing-video.mp4" }],
    };
    await persistVoiceProvenance({ mediaDir, filename: "voice.wav", script: oneShot.script, source: "test" });
    await assert.rejects(renderVideo(oneShot, mediaDir, join(mediaDir, "output.mp4")), /镜头 1.*视频文件.*不可用/);
    const validVideo = { ...oneShot, shots: [{ ...oneShot.shots[0], videoUrl: "http://localhost/__media/video-01.mp4" }] };
    await assert.rejects(renderVideo({ ...validVideo, voiceUrl: "http://localhost/__media/missing-voice.wav" }, mediaDir, join(mediaDir, "output.mp4")), /完整配音文件.*不可用/);
    assert.equal(fs.existsSync(join(mediaDir, "output.mp4")), false);
  } finally {
    await rm(mediaDir, { recursive: true, force: true });
  }
});
