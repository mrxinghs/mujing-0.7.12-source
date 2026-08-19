import assert from "node:assert/strict";
import test from "node:test";
import { alignShotsToVoice } from "../app/timeline-sync.mjs";

test("voice duration becomes the single clock for shots and subtitles", () => {
  const shots = [
    { id: "1", narration: "短句。", duration: 7, start: 0, end: 7 },
    { id: "2", narration: "这是一句明显更长、需要更多朗读时间的解说。", duration: 7, start: 7, end: 14 },
    { id: "3", narration: "结尾。", duration: 7, start: 14, end: 21 },
  ];
  const result = alignShotsToVoice(shots, 12.345);
  assert.equal(result.ok, true);
  assert.equal(result.shots[0].start, 0);
  assert.equal(result.shots.at(-1).end, 12.345);
  assert.equal(result.shots.reduce((sum, shot) => sum + shot.duration, 0).toFixed(3), "12.345");
  assert.ok(result.shots[1].duration > result.shots[0].duration);
  assert.equal(result.shots[0].end, result.shots[1].start);
});

test("existing videos are never stretched past their previous declared durations", () => {
  const shots = [
    { id: "1", narration: "很长很长的一句话，需要较多时间。", duration: 4 },
    { id: "2", narration: "短句。", duration: 8 },
  ];
  const result = alignShotsToVoice(shots, 10, { preserveExistingVideoLengths: true });
  assert.equal(result.ok, true);
  assert.ok(result.shots[0].duration <= 4);
  assert.ok(result.shots[1].duration <= 8);
  assert.equal(result.shots.at(-1).end, 10);
});

test("alignment fails closed when a longer narration would overrun existing videos", () => {
  const shots = [{ id: "1", narration: "一句话。", duration: 4 }];
  const result = alignShotsToVoice(shots, 6, { preserveExistingVideoLengths: true });
  assert.equal(result.ok, false);
  assert.match(result.reason, /配音比现有视频时间线更长/);
});
