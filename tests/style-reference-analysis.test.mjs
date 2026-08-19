import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { VALID_PNG } from "./image-fixtures.mjs";

const require = createRequire(import.meta.url);
const providers = require("../desktop/providers.cjs");

test("custom style reference UI is wired through the desktop bridge", () => {
  const page = fs.readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  const preload = fs.readFileSync(new URL("../desktop/preload.cjs", import.meta.url), "utf8");
  const main = fs.readFileSync(new URL("../desktop/main.cjs", import.meta.url), "utf8");
  assert.match(page, /导入风格参考图/);
  assert.match(page, /AI 分析参考图/);
  assert.match(page, /customStyleReferenceImage/);
  assert.match(preload, /ai:analyze-style-reference/);
  assert.match(main, /ai:analyze-style-reference/);
});

test("style analysis sends the image to the storyboard model and returns a reusable prompt", async () => {
  const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), "mujing-style-reference-"));
  fs.writeFileSync(path.join(mediaDir, "reference.png"), VALID_PNG);
  const originalFetch = globalThis.fetch;
  let requestBody;
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ output: [{ content: [{ type: "output_text", text: JSON.stringify({ prompt: "低饱和自然色彩，柔和侧逆光，克制构图与细腻颗粒；保持全片视觉一致，人物身份由角色母版另行控制，无文字、无水印。" }) }] }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await providers.analyzeStyleReference(
      { apiKey: "fake", baseUrl: "https://api.openai.com/v1", storyboardModel: "fake-model" },
      { imageUrl: "http://127.0.0.1/__media/reference.png", ratio: "16:9", existingPrompt: "" },
      mediaDir,
    );
    assert.match(result.prompt, /低饱和/);
    assert.equal(requestBody.model, "fake-model");
    assert.match(requestBody.input[0].content[1].image_url, /^data:image\/png;base64,/);
    assert.match(requestBody.input[0].content[0].text, /不得描述或复用图片中的人物身份/);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(mediaDir, { recursive: true, force: true });
  }
});
