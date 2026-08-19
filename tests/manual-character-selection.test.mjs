import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("users can add, configure, import and remove extra characters", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /function addManualCharacter\(\)/);
  assert.match(page, /manualCharacters\.length >= 8/);
  assert.match(page, /手动增加角色/);
  assert.match(page, /导入参考图/);
  assert.match(page, /generateCharacterImage\(character\.id\)/);
  assert.match(page, /removeManualCharacter\(character\)/);
});

test("each shot can override automatic character selection and restore it later", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /characterSelectionMode\?: "auto" \| "manual"/);
  assert.match(page, /shot\.characterSelectionMode === "manual"[\s\S]*shot\.characterIds/);
  assert.match(page, /function setShotCharacterSelection/);
  assert.match(page, /手动选择出镜角色/);
  assert.match(page, /当前使用你的选择；自动识别不会覆盖/);
  assert.match(page, /恢复自动识别/);
  assert.match(page, /characterSelectionMode: raw\.characterSelectionMode === "manual"/);
});
