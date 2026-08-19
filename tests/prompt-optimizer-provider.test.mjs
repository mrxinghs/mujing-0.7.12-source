import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const providers = require("../desktop/providers.cjs");

test("AI prompt optimizer returns a bounded prompt from the storyboard model", async () => {
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ output_text: '{"prompt":"坚定地拒绝，眉眼收紧，写实电影光，无文字、无水印。"}' }), { status: 200, headers: { "content-type": "application/json" } });
    const result = await providers.optimizeImagePrompt({ apiKey: "fake", storyboardModel: "fake-model" }, { narration: "错的事，我反对。", visual: "主角抬手拒绝", ratio: "16:9", style: "电影写实", characters: [{ name: "叙述者", stage: "adult", description: "成年男性" }] });
    assert.match(result.prompt, /坚定地拒绝/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("AI video prompt optimizer returns detailed bounded motion instructions", async () => {
  const previousFetch = globalThis.fetch;
  try {
    let sentInstruction = "";
    globalThis.fetch = async (_url, init) => {
      sentInstruction = JSON.parse(init.body).input;
      return new Response(JSON.stringify({ output_text: '{"prompt":"5秒中景，人物从静止到抬手拒绝，镜头缓慢推进后稳定停下，保持五官一致且无主体漂移。"}' }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const result = await providers.optimizeVideoPrompt({ apiKey: "fake", storyboardModel: "fake-model" }, { videoProvider: "本地 ComfyUI", videoModel: "wan2.2-ti2v-5b", narration: "错的事，我反对。", visual: "主角抬手拒绝", duration: 5, shotType: "中景", camera: "缓慢推进", ratio: "16:9", style: "电影写实", imageRole: "reference_image", faceVisibility: "visible", characters: [{ name: "叙述者", stage: "adult", description: "成年男性", hasMasterImage: true }] });
    assert.match(result.prompt, /镜头缓慢推进/);
    assert.match(result.prompt, /五官一致/);
    assert.match(sentInstruction, /只安排一个主要动作/);
    assert.match(sentInstruction, /120–260 个汉字/);
    assert.match(sentInstruction, /当前 Wan 工作流会把分镜图作为实际起始参考/);
    assert.match(sentInstruction, /wan2\.2-ti2v-5b/);
    assert.match(sentInstruction, /按 Wan 图片转视频规范编写/);
    assert.match(sentInstruction, /角色母版已经先用于生成分镜图/);
    assert.match(sentInstruction, /保持输入图中的头部角度、侧脸方向和脸部大小/);
    assert.match(sentInstruction, /人物与摄影机不得同时大幅运动/);
    assert.match(sentInstruction, /脸部像素不足时不得凭空补画五官/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("a custom ComfyUI workflow does not silently inherit Wan-only prompt rules", async () => {
  const previousFetch = globalThis.fetch;
  try {
    let sentInstruction = "";
    globalThis.fetch = async (_url, init) => {
      sentInstruction = JSON.parse(init.body).input;
      return new Response(JSON.stringify({ output_text: '{"prompt":"4秒，主体完成一个动作，镜头稳定停下。"}' }), { status: 200, headers: { "content-type": "application/json" } });
    };
    await providers.optimizeVideoPrompt({ apiKey: "fake", storyboardModel: "fake-model" }, { videoProvider: "本地 ComfyUI", videoModel: "custom-workflow:ltx-video-api.json", narration: "他转身。", visual: "人物中景", duration: 4, shotType: "中景", camera: "固定", imageRole: "reference_image" });
    assert.match(sentInstruction, /custom-workflow:ltx-video-api\.json/);
    assert.match(sentInstruction, /兼容性最高的自然语言结构/);
    assert.doesNotMatch(sentInstruction, /按 Wan 图片转视频规范编写/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("initial storyboard video prompts receive the selected video model profile", async () => {
  const previousFetch = globalThis.fetch;
  try {
    let sentInstruction = "";
    globalThis.fetch = async (_url, init) => {
      sentInstruction = JSON.parse(init.body).input;
      return new Response(JSON.stringify({ output_text: '[{"narration":"他抬起头。","duration":4,"visual":"人物抬头","shotType":"近景","camera":"缓慢推进","imagePrompt":"人物近景","videoPrompt":"人物抬头"}]' }), { status: 200, headers: { "content-type": "application/json" } });
    };
    await providers.createStoryboard({ apiKey: "fake", storyboardModel: "fake-model" }, { videoProvider: "Seedance", videoModel: "doubao-seedance-2-5-260628", videoImageRole: "reference_image", script: "他抬起头。", ratio: "16:9", pace: "自然", style: "电影写实", characters: [] });
    assert.match(sentInstruction, /doubao-seedance-2-5-260628/);
    assert.match(sentInstruction, /按 Seedance 自然语言视频规范编写/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("AI video prompt optimizer switches rules with the selected video model", async () => {
  const previousFetch = globalThis.fetch;
  try {
    let sentInstruction = "";
    globalThis.fetch = async (_url, init) => {
      sentInstruction = JSON.parse(init.body).input;
      return new Response(JSON.stringify({ output_text: '{"prompt":"4秒，人物抬头，摄影机缓慢推进并稳定停下。"}' }), { status: 200, headers: { "content-type": "application/json" } });
    };
    await providers.optimizeVideoPrompt({ apiKey: "fake", storyboardModel: "fake-model" }, { videoProvider: "Seedance", videoModel: "doubao-seedance-2-5-260628", narration: "他抬起头。", visual: "人物近景", duration: 4, shotType: "近景", camera: "推进", imageRole: "reference_image" });
    assert.match(sentInstruction, /doubao-seedance-2-5-260628/);
    assert.match(sentInstruction, /按 Seedance 自然语言视频规范编写/);
    assert.doesNotMatch(sentInstruction, /目标是 本地 ComfyUI/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("AI video prompt optimizer protects identity when the approved frame hides the face", async () => {
  const previousFetch = globalThis.fetch;
  try {
    let sentInstruction = "";
    globalThis.fetch = async (_url, init) => {
      sentInstruction = JSON.parse(init.body).input;
      return new Response(JSON.stringify({ output_text: '{"prompt":"4秒，人物保持背向镜头自然前行，摄影机低速跟拍，服装轮廓稳定。"}' }), { status: 200, headers: { "content-type": "application/json" } });
    };
    await providers.optimizeVideoPrompt({ apiKey: "fake", storyboardModel: "fake-model" }, { videoProvider: "本地 ComfyUI", narration: "我走进小镇。", visual: "人物背影沿石板路前行", currentPrompt: "人物向前走", duration: 4, shotType: "中景", camera: "稳定跟拍", imageRole: "reference_image", faceVisibility: "hidden", characters: [{ name: "推开木窗", stage: "adult", description: "成年男性", hasMasterImage: true }] });
    assert.match(sentInstruction, /不得强行转身露出正脸/);
    assert.match(sentInstruction, /只保持体型、发型轮廓、服装、步态和背向姿态/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("AI video prompt optimizer hard-caps verbose model output", async () => {
  const previousFetch = globalThis.fetch;
  try {
    const verbose = `4秒，人物自然前行，镜头稳定跟拍，${"环境细节缓慢变化，".repeat(80)}主体保持稳定。`;
    globalThis.fetch = async () => new Response(JSON.stringify({ output_text: JSON.stringify({ prompt: verbose }) }), { status: 200, headers: { "content-type": "application/json" } });
    const result = await providers.optimizeVideoPrompt({ apiKey: "fake", storyboardModel: "fake-model" }, { narration: "进入小镇。", visual: "人物背影前行", duration: 4, shotType: "中景", camera: "跟拍", faceVisibility: "hidden" });
    assert.ok(Array.from(result.prompt).length <= 261);
    assert.match(result.prompt, /人物自然前行/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
