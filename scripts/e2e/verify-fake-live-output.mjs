import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const options = Object.fromEntries(process.argv.slice(2).map((item) => {
  const [key, ...rest] = item.replace(/^--/, "").split("=");
  return [key, rest.join("=")];
}));
for (const required of ["video", "fixture", "project", "manifest", "sources", "evidence"]) {
  if (!options[required]) throw new Error(`缺少 --${required}`);
}
const videoPath = resolve(options.video);
const fixturePath = resolve(options.fixture);
const projectPath = resolve(options.project);
const manifestPath = resolve(options.manifest);
const sourceDir = resolve(options.sources);
const evidenceDir = resolve(options.evidence);
await mkdir(evidenceDir, { recursive: true });

function run(command, args, encoding = "utf8") {
  const result = spawnSync(command, args, { encoding, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} 失败：${String(result.stderr).slice(-2000)}`);
  return result;
}
function normalized(value) { return String(value || "").normalize("NFKC").replace(/\s+/g, ""); }
function normalizedScript(value) { return String(value || "").normalize("NFKC").replace(/\r\n?/g, "\n").trim(); }
function sha(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function hamming(left, right) {
  let distance = 0;
  for (let index = 0; index < left.length; index += 1) {
    let value = left[index] ^ right[index];
    while (value) { distance += value & 1; value >>>= 1; }
  }
  return distance;
}
function frameSignature(input, time, output) {
  run("ffmpeg", ["-y", "-v", "error", "-ss", time.toFixed(3), "-i", input, "-frames:v", "1", output]);
  const gray = Buffer.from(run("ffmpeg", ["-v", "error", "-i", output, "-vf", "scale=9:8:flags=area,format=gray", "-frames:v", "1", "-f", "rawvideo", "-"], null).stdout);
  const hash = Buffer.alloc(8);
  for (let y = 0; y < 8; y += 1) for (let x = 0; x < 8; x += 1) if (gray[y * 9 + x] > gray[y * 9 + x + 1]) hash[y] |= 1 << x;
  const rgb = Buffer.from(run("ffmpeg", ["-v", "error", "-i", output, "-vf", "scale=1:1:flags=area,format=rgb24", "-frames:v", "1", "-f", "rawvideo", "-"], null).stdout);
  return { fileSha256: sha(readFileSync(output)), perceptualHash: hash.toString("hex"), hashBytes: hash, averageRgb: [...rgb.slice(0, 3)] };
}

const fixture = (await readFile(fixturePath, "utf8")).trim();
const project = JSON.parse(await readFile(projectPath, "utf8"));
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
assert.equal(project.shots.length, 16);
assert.equal(manifest.kind, "complete-movie");
assert.equal(manifest.shots.length, 16);
assert.equal(normalized(project.shots.map((shot) => shot.narration).join("")), normalized(fixture));

const probe = JSON.parse(run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", videoPath]).stdout);
await writeFile(resolve(evidenceDir, "fake-live-ffprobe.json"), `${JSON.stringify(probe, null, 2)}\n`, "utf8");
const video = probe.streams.find((stream) => stream.codec_type === "video");
const audio = probe.streams.find((stream) => stream.codec_type === "audio");
const subtitle = probe.streams.find((stream) => stream.codec_type === "subtitle");
assert.equal(video?.codec_name, "h264");
assert.equal(audio?.codec_name, "aac");
assert.equal(subtitle?.codec_name, "mov_text");
assert.equal(subtitle?.tags?.language, "zho");
assert.equal(video?.width, 1920);
assert.equal(video?.height, 1080);
const [frameRateNumerator, frameRateDenominator] = String(video?.avg_frame_rate || "0/1").split("/").map(Number);
assert.ok(frameRateDenominator > 0 && Math.abs(frameRateNumerator / frameRateDenominator - 30) <= 0.01, `video frame rate is not approximately 30 fps: ${video?.avg_frame_rate}`);
assert.ok(Math.abs(Number(probe.format.duration) - manifest.totalDuration) <= 0.25);
for (const [kind, duration] of [["video", video?.duration], ["audio", audio?.duration], ["subtitle", subtitle?.duration], ["container", probe.format.duration]]) {
  assert.ok(Math.abs(Number(duration) - manifest.totalDuration) <= 0.25, `${kind} duration does not cover the trusted timeline`);
}
assert.equal(manifest.voice.scriptSha256, sha(Buffer.from(normalizedScript(fixture), "utf8")), "trusted voice script hash mismatch");
assert.ok(Math.abs(Number(manifest.voice.sourceDuration) - manifest.totalDuration) <= 0.25, "original trusted voice duration does not match timeline");
assert.match(manifest.voice.inputAudioSha256, /^[a-f0-9]{64}$/);
assert.ok(manifest.voice.mediaId);
assert.ok(Number(audio?.duration) >= manifest.totalDuration - 0.25, "音频流未覆盖成片总时长");

const subtitlePath = resolve(evidenceDir, "fake-live-subtitles.srt");
run("ffmpeg", ["-y", "-v", "error", "-i", videoPath, "-map", "0:s:0", subtitlePath]);
const subtitleText = (await readFile(subtitlePath, "utf8")).split(/\r?\n/).filter((line) => line && !/^\d+$/.test(line) && !line.includes(" --> ")).join("");
assert.equal(normalized(subtitleText), normalized(fixture));

const bindingFrames = [];
for (const [index, shot] of manifest.shots.entries()) {
  const shotNumber = String(index + 1).padStart(2, "0");
  const sourcePath = join(sourceDir, `video-shot-${shotNumber}.mp4`);
  const sourceBytes = await readFile(sourcePath);
  assert.equal(sha(sourceBytes), shot.inputVideoSha256, `镜头 ${shotNumber} manifest 输入哈希不匹配`);
  assert.equal(shot.shotId, project.shots[index].id);
  assert.equal(shot.duration, project.shots[index].duration);
  assert.equal(shot.requestedDuration, project.shots[index].duration);
  assert.ok(Number(shot.sourceDuration) >= shot.requestedDuration - 0.25, `shot ${shotNumber} source duration is too short`);
  const sourceFrame = resolve(evidenceDir, `.fake-live-source-${shotNumber}.png`);
  const finalFrame = resolve(evidenceDir, `fake-live-frame-shot-${shotNumber}.png`);
  const sourceSignature = frameSignature(sourcePath, shot.duration / 2, sourceFrame);
  const finalSignature = frameSignature(videoPath, shot.finalStart + shot.duration / 2, finalFrame);
  await rm(sourceFrame, { force: true });
  const hashDistance = hamming(sourceSignature.hashBytes, finalSignature.hashBytes);
  const colorDistance = sourceSignature.averageRgb.reduce((sum, value, channel) => sum + Math.abs(value - finalSignature.averageRgb[channel]), 0);
  assert.ok(hashDistance <= 12, `镜头 ${shotNumber} marker 感知哈希不匹配：${hashDistance}`);
  assert.ok(colorDistance <= 24, `镜头 ${shotNumber} 主色不匹配：${colorDistance}`);
  bindingFrames.push({
    shotId: shot.shotId,
    marker: `SHOT_${shotNumber}@${24 + (index % 8) * 70},${24 + Math.floor(index / 8) * 58}`,
    expectedColor: `#${["264653", "2a9d8f", "e9c46a", "f4a261", "e76f51", "355070", "6d597a", "b56576", "eaac8b", "386641", "6a994e", "a7c957", "bc4749", "1d3557", "457b9d", "e63946"][index]}`,
    sourceVideo: basename(sourcePath),
    inputVideoSha256: shot.inputVideoSha256,
    finalTime: shot.finalStart + shot.duration / 2,
    finalFrame: basename(finalFrame),
    sourceFrameSha256: sourceSignature.fileSha256,
    finalFrameSha256: finalSignature.fileSha256,
    sourcePerceptualHash: sourceSignature.perceptualHash,
    finalPerceptualHash: finalSignature.perceptualHash,
    perceptualHashDistance: hashDistance,
    sourceAverageRgb: sourceSignature.averageRgb,
    finalAverageRgb: finalSignature.averageRgb,
    colorDistance,
    markerColorHashBindingPassed: true,
  });
}
assert.equal(new Set(bindingFrames.map((item) => item.sourcePerceptualHash)).size, 16, "16 个源视频 marker 不够可区分");
await writeFile(resolve(evidenceDir, "fake-live-16-shot-frame-binding-report.json"), `${JSON.stringify({ passed: true, shots: bindingFrames }, null, 2)}\n`, "utf8");

const decode = spawnSync("ffmpeg", ["-v", "error", "-i", videoPath, "-map", "0:v:0", "-map", "0:a:0", "-f", "null", "NUL"], { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
assert.equal(decode.status, 0, decode.stderr);
assert.equal(String(decode.stderr || "").trim(), "", "完整解码出现错误");
await writeFile(resolve(evidenceDir, "fake-live-full-decode-report.json"), `${JSON.stringify({ passed: true, exitCode: decode.status, decodeErrors: [] }, null, 2)}\n`, "utf8");
await writeFile(resolve(evidenceDir, "fake-live-coverage-report.json"), `${JSON.stringify({
  passed: true,
  shots: project.shots.length,
  narrationNormalizedEqualsFixture: true,
  speechInputNormalizedEqualsFixture: true,
  subtitleNormalizedEqualsFixture: true,
  audioCoversTotalDuration: true,
  totalDuration: manifest.totalDuration,
  audioDuration: Number(audio.duration),
  trustedVoiceSourceDuration: Number(manifest.voice.sourceDuration),
  trustedVoiceScriptSha256: manifest.voice.scriptSha256,
  allSourceDurationsCoverRequested: manifest.shots.every((shot) => shot.sourceDuration >= shot.requestedDuration - 0.25),
}, null, 2)}\n`, "utf8");

const report = {
  passed: true,
  file: basename(videoPath),
  bytes: (await stat(videoPath)).size,
  sha256: sha(await readFile(videoPath)),
  totalDuration: manifest.totalDuration,
  video: { codec: video.codec_name, width: video.width, height: video.height, fps: video.avg_frame_rate },
  audio: { codec: audio.codec_name, duration: Number(audio.duration), sourceDuration: Number(manifest.voice.sourceDuration), scriptSha256: manifest.voice.scriptSha256, coversTotalDuration: true },
  subtitle: { codec: subtitle.codec_name, language: subtitle.tags.language, normalizedEqualsFixture: true },
  completeDecodeErrors: 0,
  verifiedShotMidpoints: bindingFrames.length,
};
await writeFile(resolve(evidenceDir, "fake-live-media-validation-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(JSON.stringify(report));
