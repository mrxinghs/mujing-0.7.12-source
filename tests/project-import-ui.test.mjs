import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("sidebar can import a previously saved story package and exported packages retain voice provenance", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /导入项目制作包/);
  assert.match(page, /accept="\.story,\.json,\.story\.json,application\/json"/);
  assert.match(page, /parseProjectPackageText\(await file\.text\(\)\)/);
  assert.match(page, /version: 12[\s\S]*voiceProvenance/);
  assert.match(page, /导入.*会替换当前项目/);
});

test("storyboard requests advertise rhythm-driven cinematic shot design", async () => {
  const providers = await readFile(new URL("../desktop/providers.cjs", import.meta.url), "utf8");
  assert.match(providers, /不能机械地按固定 3 秒切镜头/);
  assert.match(providers, /环境建立、空间交代、重要情绪停顿/);
  assert.match(providers, /相邻镜头不得连续使用相同景别/);
});
