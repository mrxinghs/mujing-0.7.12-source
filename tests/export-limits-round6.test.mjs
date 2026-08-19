import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const render = require("../desktop/render.cjs");

function shot(index, duration = 1, narration = "字") {
  return {
    id: `shot-${index}`,
    videoState: "ready",
    videoUrl: `http://localhost/__media/video-${index}.mp4`,
    narration,
    visual: "画面",
    imagePrompt: "图片提示词",
    videoPrompt: "视频提示词",
    duration,
  };
}

function payload(shots) {
  return {
    script: shots.map((item) => item.narration).join(""),
    voiceUrl: "http://localhost/__media/voice.wav",
    shots,
  };
}

test("complete export enforces shot-count limits before any per-shot media work", () => {
  const hundredThousand = Array.from({ length: 100_000 }, (_, index) => shot(index));
  assert.throws(() => render.validateCompleteRenderPayload(payload(hundredThousand)), /最多 500.*实际 100000/);
  const fiveHundredOne = Array.from({ length: 501 }, (_, index) => shot(index));
  assert.throws(() => render.validateCompleteRenderPayload(payload(fiveHundredOne)), /最多 500.*实际 501/);
});

test("complete export enforces finite per-shot and total duration limits", () => {
  assert.throws(() => render.validateCompleteRenderPayload(payload([shot(1, 300.001)])), /镜头 1.*最多 300 秒.*实际 300\.001/);
  assert.throws(() => render.validateCompleteRenderPayload(payload([shot(1, Number.NaN)])), /镜头 1.*有限数字/);
  assert.throws(() => render.validateCompleteRenderPayload(payload([shot(1, Number.POSITIVE_INFINITY)])), /镜头 1.*有限数字/);
  const overSixHours = Array.from({ length: 73 }, (_, index) => shot(index, 300));
  assert.throws(() => render.validateCompleteRenderPayload(payload(overSixHours)), /总时长最多 21600 秒.*实际 21900/);
});

test("complete export enforces Unicode code-point text limits with explicit actual counts", () => {
  const longScript = "😀".repeat(100_001);
  assert.throws(() => render.validateCompleteRenderPayload({ ...payload([shot(1, 1, longScript)]), script: longScript }), /文稿最多 100000 个 Unicode 字符.*实际 100001/);
  const longNarration = "旁".repeat(10_001);
  assert.throws(() => render.validateCompleteRenderPayload(payload([shot(1, 1, longNarration)])), /镜头 1.*narration.*最多 10000.*实际 10001/);
});

test("complete export rejects sparse and non-plain shot structures", () => {
  const sparse = new Array(2);
  sparse[0] = shot(1, 1, "甲");
  assert.throws(() => render.validateCompleteRenderPayload({ ...payload([sparse[0]]), script: "甲", shots: sparse }), /镜头数组.*稀疏/);
  assert.throws(() => render.validateCompleteRenderPayload({ ...payload([shot(1)]), shots: [new Date()] }), /镜头 1.*普通对象/);
});

test("documented 500-shot and six-hour boundaries are accepted by pure validation", () => {
  const maxShots = Array.from({ length: 500 }, (_, index) => shot(index, index === 499 ? 143 : 43));
  assert.doesNotThrow(() => render.validateCompleteRenderPayload(payload(maxShots)));
  assert.equal(maxShots.reduce((sum, item) => sum + item.duration, 0), 21_600);
  assert.doesNotThrow(() => render.validateCompleteRenderPayload(payload([shot(1, 0.5)])));
  assert.doesNotThrow(() => render.validateCompleteRenderPayload(payload([shot(1, 300)])));
});

test("all workload-limit failures occur before render-job creation or media probing", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mujing-export-limit-order-"));
  const mediaDir = path.join(directory, "media");
  fs.mkdirSync(mediaDir, { recursive: true });
  const longScript = "稿".repeat(100_001);
  const longNarration = "旁".repeat(10_001);
  const cases = [
    [payload(Array.from({ length: 100_000 }, (_, index) => shot(index))), /100000/],
    [payload(Array.from({ length: 501 }, (_, index) => shot(index))), /501/],
    [payload([shot(1, 301)]), /301/],
    [payload(Array.from({ length: 73 }, (_, index) => shot(index, 300))), /21900/],
    [payload([shot(1, Number.NaN)]), /有限数字/],
    [payload([shot(1, Number.POSITIVE_INFINITY)]), /有限数字/],
    [{ ...payload([shot(1, 1, longScript)]), script: longScript }, /100001/],
    [payload([shot(1, 1, longNarration)]), /10001/],
  ];
  try {
    for (const [invalid, pattern] of cases) {
      await assert.rejects(render.renderVideo(invalid, mediaDir, path.join(directory, "must-not-exist.mp4")), pattern);
      assert.equal(fs.existsSync(path.join(mediaDir, "render-jobs")), false);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("providers and musicVolume are structurally bounded before render-job creation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mujing-export-provider-limit-"));
  const mediaDir = path.join(directory, "media");
  fs.mkdirSync(mediaDir, { recursive: true });
  const base = payload([shot(1)]);
  const hundredThousand = Object.fromEntries(Array.from({ length: 100_000 }, (_, index) => [`provider_${index}`, "value"]));
  const fiftyOne = Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`provider_${index}`, "value"]));
  const dangerous = JSON.parse('{"__proto__":"value"}');
  const invalidCases = [
    [{ ...base, providers: hundredThousand }, /provider.*50|最多 50/],
    [{ ...base, providers: fiftyOne }, /provider.*50|最多 50/],
    [{ ...base, providers: { ["p".repeat(101)]: "value" } }, /provider.*100|键.*100/],
    [{ ...base, providers: dangerous }, /__proto__|危险|保留/],
    [{ ...base, providers: { constructor: "value" } }, /constructor|危险|保留/],
    [{ ...base, providers: { prototype: "value" } }, /prototype|危险|保留/],
    ...[Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 1.1, "0.5"].map((musicVolume) => [
      { ...base, musicVolume },
      /musicVolume.*有限数字|musicVolume.*0.*1/,
    ]),
  ];
  try {
    for (const [invalid, pattern] of invalidCases) {
      await assert.rejects(render.renderVideo(invalid, mediaDir, path.join(directory, "must-not-exist.mp4")), pattern);
      assert.equal(fs.existsSync(path.join(mediaDir, "render-jobs")), false, "validation must precede every job/file/probe operation");
    }
    for (const musicVolume of [undefined, 0, 0.5, 1]) {
      assert.doesNotThrow(() => render.validateCompleteRenderPayload({ ...base, musicVolume }));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
