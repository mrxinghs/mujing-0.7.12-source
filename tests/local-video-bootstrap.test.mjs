import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const launcher = await readFile(new URL("../scripts/local-video-service/start-mujing-local-video.ps1", import.meta.url), "utf8");
const installer = await readFile(new URL("../build/installer.nsh", import.meta.url), "utf8");

test("installer includes a removable desktop launcher for the local video service", () => {
  assert.ok(packageJson.build.extraResources.some((item) => item.to === "local-video-service"));
  assert.equal(packageJson.build.nsis.include, "build/installer.nsh");
  assert.match(installer, /启动幕境本地视频服务\.lnk/);
  assert.match(installer, /customUnInstall[\s\S]*?Delete/);
});

test("first local launch installs only official ComfyUI and Wan sources on D drive", () => {
  assert.match(launcher, /D:\\MuJing-ComfyUI/);
  assert.match(launcher, /D:\\MuJing-ComfyUI-Models/);
  assert.match(launcher, /github\.com\/Comfy-Org\/ComfyUI\/releases\/latest\/download/);
  assert.match(launcher, /huggingface\.co\/Comfy-Org\/Wan_2\.2_ComfyUI_Repackaged\/resolve\/main/);
  assert.match(launcher, /Get-FileHash/);
  assert.match(launcher, /35GB/);
  assert.match(launcher, /NVIDIA/);
});

test("local launch starts a loopback-only service with the D-drive model path", () => {
  assert.match(launcher, /"--listen", "127\.0\.0\.1"/);
  assert.match(launcher, /"--port", "8188"/);
  assert.match(launcher, /--extra-model-paths-config/);
  assert.match(launcher, /base_path: D:\/MuJing-ComfyUI-Models/);
});
