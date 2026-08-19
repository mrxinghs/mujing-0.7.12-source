import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

test("Seedance defaults to reference-image guidance without forcing the storyboard image to be frame one", () => {
  assert.match(page, /useState<VideoImageRole>\("reference_image"\)/);
  assert.match(page, /aria-label="Seedance 分镜图用途"/);
  assert.match(page, /<option value="reference_image">参考图驱动（推荐）<\/option>/);
  assert.match(page, /<option value="first_frame">严格首帧<\/option>/);
  assert.match(page, /参考人物与风格，不要求第一帧相同/);
});

test("the selected Seedance image role reaches paid submissions and survives project save and restore", () => {
  assert.match(page, /imageRole: videoImageRole/);
  assert.match(page, /exportPayload = useMemo\(\(\) => \(\{[^}]*videoImageRole/s);
  assert.match(page, /setVideoImageRole\(project\.videoImageRole === "first_frame" \? "first_frame" : "reference_image"\)/);
  assert.match(page, /resolution: "720p", imageRole: videoImageRole, generateAudio: false/);
});
