import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
const storyboardHandler = source.slice(
  source.indexOf("function runGenerateStoryboard"),
  source.indexOf("function updateShot"),
);

test("storyboard generation never references an unrelated asset kind before opening confirmation", () => {
  assert.doesNotMatch(storyboardHandler, /kind\s*===\s*["']video["']/);
  assert.match(storyboardHandler, /appSettings\.mode === ["']live["'] && !noticeConfirmed/);
});

test("every storyboard entry path reports rejected async startup instead of becoming a dead click", () => {
  assert.match(storyboardHandler, /handleGenerateStoryboard\(noticeConfirmed\)\.catch/);
  assert.match(storyboardHandler, /failGenerationProgress\(progressId, message\)/);
  assert.match(source, /if \(!shots\.length\) runGenerateStoryboard\(\)/);
  assert.match(storyboardHandler, /\(\) => runGenerateStoryboard\(true\)/);
});
