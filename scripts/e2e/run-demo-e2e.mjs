import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const options = Object.fromEntries(process.argv.slice(2).map((item) => {
  const [key, ...rest] = item.replace(/^--/, "").split("=");
  return [key, rest.join("=")];
}));
const evidenceDir = resolve(options.evidence || "e2e-evidence");
const fixturePath = resolve(options.fixture || "tests/fixtures/core-journey-zh.txt");
await mkdir(evidenceDir, { recursive: true });
const runtimeDir = await mkdtemp(join(os.tmpdir(), "mujing-demo-e2e-"));
const profileDir = join(runtimeDir, "profile");
await mkdir(profileDir, { recursive: true });

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(() => resolvePort(port)); });
  });
}

function runNode(args, timeout = 360_000) {
  const result = spawnSync(process.execPath, args, { cwd: resolve("."), encoding: "utf8", windowsHide: true, timeout, maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${args[0]} 失败：\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

const debugPort = await freePort();
const electron = spawn(electronPath, [".", `--user-data-dir=${profileDir}`, `--remote-debugging-port=${debugPort}`], {
  cwd: resolve("."),
  env: { ...process.env },
  windowsHide: false,
  stdio: ["ignore", "pipe", "pipe"],
});
try {
  let ready = false;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !ready) {
    try { const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json(); ready = targets.some((item) => item.type === "page" && /幕境/.test(item.title)); } catch { /* booting */ }
    if (!ready) await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  assert.equal(ready, true, "Demo 隔离 Electron 未启动");
  const driverOutput = runNode([
    "scripts/e2e/drive-demo.mjs",
    `--port=${debugPort}`,
    `--fixture=${fixturePath}`,
    `--evidence=${evidenceDir}`,
  ]);
  const report = {
    passed: true,
    command: "npm run e2e:demo",
    scope: "文稿、角色、分镜与逐镜头图片；不生成视频、不进入时间轴、不导出 MP4",
    completeMovieAccepted: false,
    isolatedProfile: true,
    driver: JSON.parse(driverOutput),
  };
  await writeFile(resolve(evidenceDir, "demo-e2e-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(JSON.stringify(report));
} finally {
  if (!electron.killed) electron.kill();
  await new Promise((resolveExit) => { const timer = setTimeout(resolveExit, 3000); electron.once("exit", () => { clearTimeout(timer); resolveExit(); }); });
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  await rm(runtimeDir, { recursive: true, force: true });
}
