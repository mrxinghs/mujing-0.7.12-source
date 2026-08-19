/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("node:fs");
const path = require("node:path");
const provider = require("../desktop/comfyui-provider.cjs");

const mediaDir = path.join(__dirname, "..", "live-comfyui-output");
const sourceImage = path.join(__dirname, "..", "live-seedance-output", "verification-frame.jpg");
const imageName = "comfyui-verification-frame.jpg";
const imagePath = path.join(mediaDir, imageName);
const config = {
  baseUrl: "http://127.0.0.1:8188",
  fps: "8",
  steps: "1",
  videoModel: "wan2.2-ti2v-5b",
};

async function main() {
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.copyFileSync(sourceImage, imagePath);

  const connection = await provider.testComfyUIConnection(config);
  console.log("CONNECTION", JSON.stringify(connection));

  const submitted = await provider.submitComfyUIVideoTask(config, {
    shotId: "configuration-smoke",
    imageUrl: `http://127.0.0.1/__media/${imageName}`,
    prompt: "静态电影画面产生轻微自然景深变化，镜头缓慢推进，保持人物外观和构图稳定，无文字，无水印",
    ratio: "16:9",
    duration: 1,
  }, mediaDir);
  console.log("SUBMITTED", JSON.stringify(submitted));

  const deadline = Date.now() + 20 * 60 * 1000;
  while (Date.now() < deadline) {
    const result = await provider.pollComfyUIVideoTask(config, submitted, mediaDir, (state) => console.log("PROGRESS", state));
    console.log("POLL", JSON.stringify(result));
    if (result.status === "succeeded") {
      console.log("SUCCEEDED", path.join(mediaDir, result.filename));
      return;
    }
    if (result.status === "failed") throw new Error(result.error || "ComfyUI smoke test failed");
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error("ComfyUI smoke test timed out");
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
