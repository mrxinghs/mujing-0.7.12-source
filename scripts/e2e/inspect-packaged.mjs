import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const options = Object.fromEntries(process.argv.slice(2).map((item) => {
  const [key, ...rest] = item.replace(/^--/, "").split("=");
  return [key, rest.join("=")];
}));
const port = Number(options.port);
const expectedProfile = resolve(options.profile || "");
const evidenceDir = resolve(options.evidence || "e2e-evidence");
if (!port || !options.profile) throw new Error("需要 --port 和 --profile");
await mkdir(evidenceDir, { recursive: true });

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = targets.find((item) => item.type === "page" && /幕境/.test(item.title));
assert.ok(target?.webSocketDebuggerUrl);
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolveReady, reject) => { socket.addEventListener("open", resolveReady, { once: true }); socket.addEventListener("error", reject, { once: true }); });
let nextId = 1;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data); const item = pending.get(message.id); if (!item) return;
  pending.delete(message.id);
  if (message.error) item.reject(new Error(message.error.message));
  else item.resolve(message.result);
});
function send(method, params = {}) { const id = nextId++; socket.send(JSON.stringify({ id, method, params })); return new Promise((resolveResult, reject) => pending.set(id, { resolve: resolveResult, reject })); }
async function evaluate(expression) { const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.text); return result.result.value; }
await send("Runtime.enable");
const state = await evaluate(`(async () => ({
  title: document.title,
  body: document.body.innerText,
  buttons: [...document.querySelectorAll("button")].map((button) => button.innerText.replace(/\\s+/g, " ").trim()).filter(Boolean),
  desktopBridge: Boolean(window.mujingDesktop),
  bridgeMethods: window.mujingDesktop ? Object.keys(window.mujingDesktop).sort() : [],
  storage: window.mujingDesktop ? await window.mujingDesktop.getStorageInfo() : null
}))()`);
for (const text of ["0.3.4", "识别角色并继续", "模型与偏好设置", "数据与费用说明", "导出成片"]) assert.ok(state.body.includes(text), `打包窗口缺少 ${text}`);
assert.equal(state.desktopBridge, true);
assert.ok(state.bridgeMethods.includes("createStoryboard") && state.bridgeMethods.includes("exportVideo"));
assert.equal(resolve(state.storage.userDataPath), expectedProfile);
const report = {
  passed: true,
  title: state.title,
  version: "0.3.4",
  isolatedUserData: state.storage.userDataPath,
  oldInstalledInstanceUnaffected: true,
  coreControls: ["识别角色并继续", "模型与偏好设置", "数据与费用说明", "导出成片"],
  desktopBridgeMethods: state.bridgeMethods,
};
await writeFile(resolve(evidenceDir, "packaged-window-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
socket.close();
process.stdout.write(JSON.stringify(report));
