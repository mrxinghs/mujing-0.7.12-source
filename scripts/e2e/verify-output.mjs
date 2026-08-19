import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const options = Object.fromEntries(process.argv.slice(2).map((item) => {
  const [key, ...rest] = item.replace(/^--/, "").split("=");
  return [key, rest.join("=")];
}));
const videoPath = resolve(options.video || "");
const fixturePath = resolve(options.fixture || "tests/fixtures/core-journey-zh.txt");
const projectPath = resolve(options.project || "");
const evidenceDir = resolve(options.evidence || "e2e-evidence");
if (!options.video || !options.project) throw new Error("需要 --video 和 --project");
await mkdir(evidenceDir, { recursive: true });

function run(command, args, encoding = "utf8") {
  const result = spawnSync(command, args, { encoding, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} 失败：${String(result.stderr).slice(-2000)}`);
  return result;
}

function normalized(value) {
  return String(value || "").replace(/\s+/g, "").trim();
}

const fixture = (await readFile(fixturePath, "utf8")).trim();
const project = JSON.parse(await readFile(projectPath, "utf8"));
const probe = JSON.parse(run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", videoPath]).stdout);
await writeFile(resolve(evidenceDir, "ffprobe.json"), `${JSON.stringify(probe, null, 2)}\n`, "utf8");

const video = probe.streams.find((stream) => stream.codec_type === "video");
const audio = probe.streams.find((stream) => stream.codec_type === "audio");
const subtitle = probe.streams.find((stream) => stream.codec_type === "subtitle");
const expectedDuration = project.shots.reduce((sum, shot) => sum + Number(shot.duration), 0);
assert.equal(video?.codec_name, "h264");
assert.equal(audio?.codec_name, "aac");
assert.equal(subtitle?.codec_name, "mov_text");
assert.equal(video?.width, project.ratio === "9:16" ? 1080 : 1920);
assert.equal(video?.height, project.ratio === "9:16" ? 1920 : 1080);
assert.equal(video?.avg_frame_rate, "30/1");
assert.ok(Math.abs(Number(probe.format.duration) - expectedDuration) <= 0.25);

const subtitlePath = resolve(evidenceDir, "subtitles.srt");
run("ffmpeg", ["-y", "-v", "error", "-i", videoPath, "-map", "0:s:0", subtitlePath]);
const subtitleText = await readFile(subtitlePath, "utf8");
const subtitleNarration = subtitleText
  .split(/\r?\n/)
  .filter((line) => line && !/^\d+$/.test(line) && !line.includes(" --> "))
  .join("");

const paragraphs = fixture.split(/\r?\n\s*\r?\n/).map((item) => item.trim()).filter(Boolean);
const shotNarration = project.shots.map((shot) => shot.narration).join("");
assert.equal(normalized(shotNarration), normalized(fixture));
assert.equal(normalized(subtitleNarration), normalized(fixture));
let shotCursor = 0;
const paragraphMappings = paragraphs.map((paragraph, paragraphIndex) => {
  const firstShot = shotCursor;
  let accumulated = "";
  while (shotCursor < project.shots.length && normalized(accumulated).length < normalized(paragraph).length) {
    accumulated += project.shots[shotCursor].narration;
    shotCursor += 1;
  }
  assert.equal(normalized(accumulated), normalized(paragraph), `第 ${paragraphIndex + 1} 段覆盖不完整或乱序`);
  return { paragraph: paragraphIndex + 1, shotIds: project.shots.slice(firstShot, shotCursor).map((shot) => shot.id), exact: true };
});
assert.equal(shotCursor, project.shots.length);
const coverageReport = {
  passed: true,
  fixtureCharacters: fixture.length,
  paragraphs: paragraphs.length,
  shots: project.shots.length,
  narrationExactAfterWhitespaceNormalization: true,
  subtitleExactAfterWhitespaceNormalization: true,
  openingCovered: normalized(shotNarration).startsWith(normalized(paragraphs[0])),
  endingCovered: normalized(shotNarration).endsWith(normalized(paragraphs.at(-1))),
  paragraphMappings,
};
await writeFile(resolve(evidenceDir, "coverage-report.json"), `${JSON.stringify(coverageReport, null, 2)}\n`, "utf8");

const seen = new Set();
let timelineCursor = 0;
const bindings = project.shots.map((shot, index) => {
  assert.ok(shot.id && !seen.has(shot.id));
  seen.add(shot.id);
  for (const key of ["narration", "visual", "imagePrompt", "videoPrompt"]) assert.ok(String(shot[key] || "").trim(), `${shot.id}.${key} 缺失`);
  assert.ok(Number(shot.duration) > 0);
  assert.deepEqual(shot.start, timelineCursor);
  assert.deepEqual(shot.end, shot.start + shot.duration);
  assert.ok(Array.isArray(shot.characterIds));
  assert.equal(shot.approved, true);
  assert.equal(shot.imageState, "ready");
  assert.equal(shot.videoState, "ready");
  assert.ok(String(shot.imageUrl).includes(shot.id), `${shot.id} 图片 URL 未绑定镜头 ID`);
  timelineCursor = shot.end;
  return {
    index,
    id: shot.id,
    narration: shot.narration,
    visual: shot.visual,
    imagePrompt: shot.imagePrompt,
    videoPrompt: shot.videoPrompt,
    duration: shot.duration,
    characterIds: shot.characterIds,
    imageResult: basename(new URL(shot.imageUrl).pathname),
    videoResult: shot.videoUrl ? basename(new URL(shot.videoUrl).pathname) : "demo-export-from-bound-image",
  };
});
await writeFile(resolve(evidenceDir, "shot-binding-report.json"), `${JSON.stringify({ passed: true, timelineDuration: timelineCursor, bindings }, null, 2)}\n`, "utf8");

const frameTimes = [1, expectedDuration / 2, Math.max(1, expectedDuration - 1)];
const frames = [];
for (const [index, time] of frameTimes.entries()) {
  const label = ["first", "middle", "last"][index];
  const output = resolve(evidenceDir, `frame-${label}.png`);
  run("ffmpeg", ["-y", "-v", "error", "-ss", time.toFixed(3), "-i", videoPath, "-frames:v", "1", output]);
  const bytes = await readFile(output);
  const averagePixel = run("ffmpeg", ["-v", "error", "-i", output, "-vf", "scale=1:1:flags=area,format=gray", "-frames:v", "1", "-f", "rawvideo", "-"], null).stdout;
  const averageLuma = Buffer.from(averagePixel)[0];
  assert.ok(averageLuma > 8, `${label} 帧接近黑屏`);
  frames.push({ label, time, file: basename(output), bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), averageLuma });
}
assert.equal(new Set(frames.map((frame) => frame.sha256)).size, frames.length, "首中尾帧内容没有变化");
const volume = run("ffmpeg", ["-v", "info", "-i", videoPath, "-map", "0:a:0", "-af", "volumedetect", "-f", "null", "NUL"]).stderr;
const meanVolume = /mean_volume:\s*(-?[\d.]+) dB/.exec(volume)?.[1];
assert.ok(meanVolume && Number(meanVolume) > -70, `音轨疑似静音：${meanVolume || "unknown"}`);
const mediaReport = {
  passed: true,
  file: basename(videoPath),
  bytes: (await stat(videoPath)).size,
  sha256: createHash("sha256").update(await readFile(videoPath)).digest("hex"),
  expectedDuration,
  actualDuration: Number(probe.format.duration),
  video: { codec: video.codec_name, width: video.width, height: video.height, fps: video.avg_frame_rate, frames: Number(video.nb_frames) },
  audio: { codec: audio.codec_name, duration: Number(audio.duration), meanVolumeDb: Number(meanVolume) },
  subtitle: { codec: subtitle.codec_name, language: subtitle.tags?.language, duration: Number(subtitle.duration), fullTextCovered: true },
  frames,
};
await writeFile(resolve(evidenceDir, "media-validation-report.json"), `${JSON.stringify(mediaReport, null, 2)}\n`, "utf8");
process.stdout.write(JSON.stringify(mediaReport));
