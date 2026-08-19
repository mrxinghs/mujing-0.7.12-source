import assert from "node:assert/strict";
import test from "node:test";
import { allocateSplitDurations, reflowShotTimeline, splitTextMatchesSource, suggestShotSplit } from "../app/manual-shot-split.mjs";

test("manual split suggests a natural sentence boundary without changing narration", () => {
  const source = "父亲低头看着账单。孩子在桌边安静等待。";
  const result = suggestShotSplit(source);
  assert.equal(result.first, "父亲低头看着账单。");
  assert.equal(result.second, "孩子在桌边安静等待。");
  assert.equal(splitTextMatchesSource(source, result.first, result.second), true);
});

test("manual split falls back to a nearby comma and rejects rewritten copy", () => {
  const source = "他推开木窗，向远处的钟楼望去";
  const result = suggestShotSplit(source);
  assert.ok(result.first.endsWith("，"));
  assert.equal(splitTextMatchesSource(source, result.first, result.second), true);
  assert.equal(splitTextMatchesSource(source, `${result.first}突然`, result.second), false);
});

test("split durations preserve total duration and timeline reflow removes gaps", () => {
  const durations = allocateSplitDurations(4.1, "第一段较短。", "第二段文案明显更长，需要更多时间。 ");
  assert.equal(Number((durations[0] + durations[1]).toFixed(3)), 4.1);
  const shots = reflowShotTimeline([{ id: "a", duration: durations[0] }, { id: "b", duration: durations[1] }, { id: "c", duration: 2.8 }]);
  assert.equal(shots[0].start, 0);
  assert.equal(shots[0].end, shots[1].start);
  assert.equal(shots[1].end, shots[2].start);
  assert.equal(shots[2].end, 6.9);
});
