import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extractShortDramaCharacters, shortDramaDuration, shortDramaLineMetadata, shortDramaShotPlan, splitShortDramaBeats } from "../app/short-drama.mjs";

const script = `场景：会议室／白天
林夏推门走进来。
林夏（冷静）：这个项目，我不会退出。
周总：你以为自己还有选择吗？
员工们低声议论。`;

test("short drama parser keeps scenes, dialogue speakers and crowds distinct", () => {
  assert.deepEqual(extractShortDramaCharacters(script), ["林夏", "周总"]);
  const beats = splitShortDramaBeats(script);
  assert.equal(beats.length, 5);
  assert.deepEqual(shortDramaLineMetadata(beats[0]), { kind: "scene", scene: "会议室／白天", speaker: "", dialogue: "", extras: "" });
  assert.equal(shortDramaLineMetadata(beats[2], "会议室／白天").speaker, "林夏");
  assert.equal(shortDramaLineMetadata(beats[4]).extras, "员工们");
});

test("short drama timing and shot language follow line function instead of fixed three seconds", () => {
  const scene = shortDramaLineMetadata("场景：会议室／白天");
  const dialogue = shortDramaLineMetadata("林夏：我不会退出。");
  assert.notEqual(shortDramaDuration("场景：会议室／白天", scene), shortDramaDuration("林夏：我不会退出。", dialogue));
  assert.match(shortDramaShotPlan(1, dialogue).shotType, /过肩|近景|反应/);
});

test("UI exposes an independent short-drama mode while preserving both aspect ratios", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const providers = await readFile(new URL("../desktop/providers.cjs", import.meta.url), "utf8");
  assert.match(page, /短剧模式/);
  assert.match(page, /16:9 横屏/);
  assert.match(page, /9:16 竖屏/);
  assert.match(page, /所属场景/);
  assert.match(page, /说话人/);
  assert.match(page, /群众演员/);
  assert.match(providers, /payload\?\.creationMode === "short_drama"/);
  assert.match(providers, /过肩反打/);
});
