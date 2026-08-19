/* eslint-disable @typescript-eslint/no-require-imports */
const path = require("node:path");
const provider = require("../desktop/comfyui-provider.cjs");

const jobId = process.argv[2];
const mediaDir = path.join(__dirname, "..", "live-comfyui-output");

provider.pollComfyUIVideoTask(
  { baseUrl: "http://127.0.0.1:8188" },
  { jobId },
  mediaDir,
  (state) => console.log("PROGRESS", state),
).then((result) => {
  console.log(JSON.stringify(result));
}).catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
