import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { inferCharacterStage, inferCharacterStages, inferNamedCharacters, inferPrimaryCharacterName, inferPrimaryCharacterProfile, inferSecondaryCharacterName } from "../app/character-inference.mjs";

test("identifies both named fixture characters without treating actions as names", async () => {
  const fixture = await readFile(new URL("./fixtures/core-journey-zh.txt", import.meta.url), "utf8");
  assert.deepEqual(inferNamedCharacters(fixture), ["林默", "苏晴"]);
  assert.equal(inferPrimaryCharacterName(fixture), "林默");
  assert.equal(inferSecondaryCharacterName(fixture, "林默"), "苏晴");
  for (const action of ["发现", "带着", "来到", "听完", "提议", "走进", "守住", "接通", "保存", "站在"]) {
    assert.equal(inferNamedCharacters(fixture).includes(action), false);
  }
});

test("keeps narrator and role-only fallbacks for existing projects", () => {
  assert.equal(inferPrimaryCharacterName("我走进雨中的小镇。"), "叙述者");
  assert.equal(inferPrimaryCharacterName("一位邮差推着自行车。"), "邮差");
  assert.equal(inferSecondaryCharacterName("邮差来到红门前，那里站着一个女孩。", "邮差"), "红门女孩");
});

test("finds a first-person protagonist and preserves one identity across childhood and adulthood", () => {
  const script = "童年时期，我和父母在狭小的餐厅吃饭。多年后，我成为律师，仍记得父亲疲惫的眼神。";
  const profile = inferPrimaryCharacterProfile(script);
  assert.equal(profile.name, "叙述者");
  assert.equal(profile.firstPerson, true);
  assert.deepEqual(profile.stages, ["child", "adult"]);
  assert.ok(profile.aliases.includes("年幼的我"));
  assert.ok(profile.aliases.includes("成年后的我"));
  assert.equal(inferCharacterStage("童年时期的叙述者坐在父母之间", profile.stages), "child");
  assert.equal(inferCharacterStage("成年叙述者在办公室整理文件", profile.stages), "adult");
});

test("does not mistake parents for the protagonist in an autobiographical script", () => {
  const script = "小时候，我看着父亲核对账单，母亲在一旁收拾餐桌。长大后，我独自回到旧屋。";
  assert.equal(inferPrimaryCharacterName(script), "叙述者");
  assert.deepEqual(inferCharacterStages(script), ["child", "adult"]);
  assert.deepEqual(inferNamedCharacters(script), []);
});
