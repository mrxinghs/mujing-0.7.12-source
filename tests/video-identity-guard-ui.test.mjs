import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

test("video submission adds an identity guard after the editable motion prompt", () => {
  assert.match(page, /const identityGuard = videoIdentityGuard\(target, boundCharactersForShot\(target\)\)/);
  assert.match(page, /target\.videoPrompt\}\$\{identityGuard \? `。\$\{identityGuard\}`/);
});

test("back-facing reference frames do not force the model to invent a face", () => {
  assert.match(page, /背影\|背向镜头\|背对镜头/);
  assert.match(page, /不得强行转身或凭空生成不可见的正脸/);
  assert.match(page, /严格继承分镜图中的背向姿态、体型、发型轮廓、服装配色和随身物品/);
});

test("multi-character shots submit every bound master to image generation and lock the ensemble in video", () => {
  assert.match(page, /boundCharactersForShot\(target\)\.map\(\(character\) => character\.masterImage\)/);
  assert.match(page, /references, enforceAspect: true/);
  assert.match(page, /不得融合或互换五官、发型、服装与身体特征/);
  assert.match(page, /保持分镜图中的左右站位、身高关系、视线方向和互动关系/);
  assert.match(page, /视频继承合成后的分镜图并锁定全部身份/);
});

test("side-facing and small-face frames use conservative Wan motion", () => {
  assert.match(page, /人物面部较小\|脸部较小/);
  assert.match(page, /严格继承分镜图中的头部角度、侧脸方向、脸部大小/);
  assert.match(page, /不做快速转头、夸张表情或连续口型/);
  assert.match(page, /脸部像素不足时不得凭空补画五官/);
});
