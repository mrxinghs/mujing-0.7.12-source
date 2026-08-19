import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createDemoCharacterDescription } from "../app/character-profile.mjs";

test("demo character profile is deterministic and contains stable visual anchors", () => {
  const input = { name: "林夏", script: "记者林夏在清晨走进雾中的小镇。" };
  const first = createDemoCharacterDescription(input);
  assert.equal(createDemoCharacterDescription(input), first);
  assert.match(first, /林夏/);
  assert.match(first, /面|眼睛/);
  assert.match(first, /发/);
  assert.match(first, /固定|保持一致/);
});

test("character page always exposes automatic prompt and reference-image generation", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /自动生成提示词/);
  assert.match(page, /一键锁定主角母版/);
  assert.match(page, /generatePrimaryCharacterPrompt/);
  assert.match(page, /createDemoCharacterReference/);
  assert.doesNotMatch(page, /if \(!source\) \{\s*setToast\("请先导入角色参考图"\)/);
});

test("cross-age profile keeps inherited facial anchors instead of redesigning the protagonist", () => {
  const description = createDemoCharacterDescription({ name: "叙述者", script: "童年时期，我和父母吃饭。多年后，我成为一名律师。" });
  assert.match(description, /童年与成年/);
  assert.match(description, /眼型、鼻型、唇形、脸部骨骼/);
  assert.match(description, /同一个人/);
});

test("desktop bridge exposes character profile generation without exposing Node", async () => {
  const [main, preload] = await Promise.all([
    readFile(new URL("../desktop/main.cjs", import.meta.url), "utf8"),
    readFile(new URL("../desktop/preload.cjs", import.meta.url), "utf8"),
  ]);
  assert.match(main, /ai:character-profile/);
  assert.match(main, /providers\.createCharacterProfile/);
  assert.match(preload, /createCharacterProfile.*ai:character-profile/);
});
