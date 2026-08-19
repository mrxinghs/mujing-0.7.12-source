import test from "node:test";
import assert from "node:assert/strict";
import { cinematicDuration, cinematicShotPlan, splitScriptIntoCinematicBeats, validateCinematicCoverage } from "../app/cinematic-storyboard.mjs";

test("cinematic beats preserve the complete narration while varying with narrative rhythm", () => {
  const script = "清晨，他沿着潮湿的石板路走进小镇，远处钟楼刚刚响起。没人知道，一封信正在改变他的命运。";
  const beats = splitScriptIntoCinematicBeats(script);
  assert.ok(beats.length >= 3);
  assert.equal(validateCinematicCoverage(script, beats), true);
  assert.ok(beats.every((beat) => cinematicDuration(beat) >= 2.2 && cinematicDuration(beat) <= 5.5));
});

test("establishing shots hold longer than detail shots for the same narration", () => {
  const narration = "他走进寂静的小镇。";
  assert.ok(cinematicDuration(narration, { shotType: "环境远景" }) > cinematicDuration(narration, { shotType: "物件细节特写" }));
});

test("adjacent cinematic plan entries vary shot size", () => {
  const types = Array.from({ length: 8 }, (_, index) => cinematicShotPlan(index).shotType);
  assert.ok(types.every((type, index) => index === 0 || type !== types[index - 1]));
  assert.ok(types.some((type) => type.includes("远景")));
  assert.ok(types.some((type) => type.includes("特写")));
});
