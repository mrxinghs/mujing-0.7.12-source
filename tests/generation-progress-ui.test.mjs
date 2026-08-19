import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test("every material generation flow reports progress in the fixed lower-right task card", () => {
  assert.match(page, /aria-label="生成任务进度"/);
  assert.match(page, /beginGenerationProgress\(creationMode === "short_drama" \? "生成短剧叙事分镜" : "生成电影叙事分镜"/);
  assert.match(page, /beginGenerationProgress\(kind === "image" \? "生成分镜图片" : "生成视频镜头"/);
  assert.match(page, /beginGenerationProgress\("生成主角提示词"/);
  assert.match(page, /beginGenerationProgress\(kind === "primary" \? "生成主角身份母版"/);
  assert.match(page, /beginGenerationProgress\("生成解说配音并对齐"/);
  assert.match(page, /beginGenerationProgress\("渲染完整成片"/);
  assert.match(page, /已完成 \{generationProgress\.current\} \/ \{generationProgress\.total\}/);
  assert.match(css, /\.generation-progress-card \{ position: fixed; z-index: 79; right:/);
  assert.match(css, /\.generation-progress-track\.indeterminate/);
  assert.match(css, /\.generation-progress-card\.error/);
  assert.match(css, /\.generation-progress-card\.canceled/);
});

test("long provider errors wrap inside shot cards and fixed notices", () => {
  assert.match(css, /\.character-error, \.shot-error \{[^}]*max-width: 100%;[^}]*overflow-wrap: anywhere;[^}]*word-break: break-word;/s);
  assert.match(css, /\.generation-progress-card \{[^}]*grid-template-columns: 40px minmax\(0, 1fr\) auto;[^}]*overflow: auto;/s);
  assert.match(css, /\.generation-progress-copy p \{[^}]*max-height: 7\.5em;[^}]*overflow-wrap: anywhere;[^}]*word-break: break-word;/s);
  assert.match(css, /\.toast \{[^}]*width: min\(760px, calc\(100vw - 32px\)\);[^}]*max-height: min\(180px, 35vh\);[^}]*overflow-wrap: anywhere;/s);
});

test("missing character masters explain the block without turning the image buttons into dead controls", () => {
  assert.match(page, /你仍可点击生成按钮，系统会带你前往角色页/);
  assert.match(page, /<button className="ghost-button" aria-describedby=\{missingApprovedCharacterReferences\.length \? "character-master-generation-block" : undefined\} disabled=\{busy\} onClick=\{\(\) => void generateAssets\("image"\)\}>生成全部图片<\/button>/);
  assert.match(page, /failGenerationProgress\(progressId, `缺少\$\{missingNames\}的身份母版，已暂停生成并打开角色页`\)/);
  assert.doesNotMatch(page, /disabled=\{busy \|\| missingApprovedCharacterReferences\.length > 0\}[^>]*>生成全部图片/);
});
