import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test("storyboard cards provide a persistent per-shot character age selector", () => {
  assert.match(page, /characterStageOverrides\?:/);
  assert.match(page, /手动选择年龄阶段/);
  assert.match(page, /stageForShotCharacter\(shot, character\)/);
  assert.match(page, /characterStageOverrides: \{ \.\.\.shot\.characterStageOverrides, \[character\.id\]: stage \}/);
});

test("changing a shot age refreshes prompts and invalidates mismatched generated media", () => {
  assert.match(page, /syncShotCharacters\(nextShot, activeCharacters, effectiveStyle, ratio\)/);
  assert.match(page, /imageState: "idle"/);
  assert.match(page, /videoState: "idle"/);
  assert.match(page, /请重新生成该镜头图片/);
});

test("each shot has an editable prompt with automatic performance direction", () => {
  assert.match(page, /performanceDirectionForNarration/);
  assert.match(page, /人物表情与情境表演/);
  assert.match(page, /图片生成提示词/);
  assert.match(page, /updateShotImagePrompt\(shot, event\.target\.value\)/);
  assert.match(page, /恢复 AI 提示词/);
  assert.match(page, /AI 优化提示词/);
  assert.match(page, /optimizeImagePrompt/);
});

test("each storyboard shot exposes an editable and AI-optimizable video prompt", () => {
  assert.match(page, /视频生成提示词/);
  assert.match(page, /updateShotVideoPrompt\(shot, event\.target\.value\)/);
  assert.match(page, /AI 优化视频提示词/);
  assert.match(page, /optimizeVideoPrompt/);
  assert.match(page, /AI 按 \{providers\.video\} · \{activeVideoPromptModel\(\)/);
  assert.match(page, /规范生成 · 可编辑 · 直接提交/);
});

test("each storyboard shot exposes the AI-designed shot size as an editable selector", () => {
  assert.match(page, /const shotSizeOptions = \[/);
  assert.match(page, /aria-label=\{`镜头 \$\{index \+ 1\} 景别`\}/);
  assert.match(page, /updateShotType\(shot, event\.target\.value\)/);
  assert.match(page, /景别：\$\{shot\.shotType\}/);
  assert.match(css, /\.shot-size-control select/);
});

test("storyboard prompt editors span the media and detail columns with readable adaptive type", () => {
  assert.match(page, /className="shot-wide-editors"/);
  assert.match(css, /\.shot-wide-editors \{ grid-column: 2 \/ -1;/);
  assert.match(css, /\.prompt-editor textarea \{[^}]*field-sizing: content;/s);
  assert.match(css, /\.prompt-editor textarea \{[^}]*font-size: var\(--type-body\);/s);
  assert.match(css, /\.storyboard-list \{[^}]*max-width: 1760px;/s);
});

test("an existing storyboard shot can be manually split into two editable shots", () => {
  assert.match(page, /拆成两个镜头/);
  assert.match(page, /openManualShotSplit\(shot\)/);
  assert.match(page, /confirmManualShotSplit/);
  assert.match(page, /reflowShotTimeline/);
  assert.match(page, /保持总时长不变/);
});

test("multiple existing cast members can be selected from the role library for one shot", () => {
  assert.match(page, /＋ 从角色库添加/);
  assert.match(page, /openShotCharacterLibrary\(shot\)/);
  assert.match(page, /confirmShotCharacterLibrary/);
  assert.match(page, /从角色库选择出镜角色/);
  assert.match(page, /应用到当前镜头/);
  assert.match(page, /characterSelectionMode: "manual"/);
  assert.match(page, /单镜头最多 4 个/);
});
