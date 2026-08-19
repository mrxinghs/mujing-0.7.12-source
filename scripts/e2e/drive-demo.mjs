import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const options = Object.fromEntries(process.argv.slice(2).map((item) => {
  const [key, ...rest] = item.replace(/^--/, "").split("=");
  return [key, rest.join("=")];
}));
const port = Number(options.port);
const fixturePath = resolve(options.fixture || "tests/fixtures/core-journey-zh.txt");
const evidenceDir = resolve(options.evidence || "e2e-evidence");
if (!port) throw new Error("需要 --port=<Electron remote debugging port>");

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    await new Promise((resolveReady, reject) => {
      this.socket.addEventListener("open", resolveReady, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolveResult, reject) => this.pending.set(id, { resolve: resolveResult, reject }));
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  }

  close() { this.socket.close(); }
}

async function waitFor(client, expression, label, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await client.evaluate(expression);
    if (last) return last;
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error(`等待超时：${label}；最后状态=${JSON.stringify(last)}`);
}

function clickButtonExpression(text) {
  return `(() => {
    const button = [...document.querySelectorAll("button")].find((item) => item.innerText.replace(/\\s+/g, "").includes(${JSON.stringify(text.replace(/\s+/g, ""))}));
    if (!button) throw new Error("找不到按钮：${text}");
    if (button.disabled) throw new Error("按钮被禁用：${text}");
    button.click();
    return button.innerText;
  })()`;
}

async function project(client) {
  return client.evaluate(`(() => { try { return JSON.parse(localStorage.getItem("mujing-project-v1") || "{}"); } catch { return {}; } })()`);
}

const fixture = (await readFile(fixturePath, "utf8")).trim();
await mkdir(evidenceDir, { recursive: true });
await writeFile(resolve(evidenceDir, "core-journey-zh.txt"), `${fixture}\n`, "utf8");

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((target) => target.type === "page" && /幕境/.test(target.title));
assert.ok(page?.webSocketDebuggerUrl, "没有找到隔离幕境 renderer target");
const client = new CdpClient(page.webSocketDebuggerUrl);
await client.connect();
await client.send("Runtime.enable");

const trace = [];
const mark = async (name) => {
  const value = await client.evaluate(`({ name: ${JSON.stringify(name)}, at: new Date().toISOString(), text: document.body.innerText.slice(0, 1200), project: (() => { try { return JSON.parse(localStorage.getItem("mujing-project-v1") || "{}"); } catch { return {}; } })() })`);
  trace.push(value);
};

try {
  await waitFor(client, `document.querySelector("textarea") && document.body.innerText.includes("识别角色并继续")`, "文稿页加载");
  await mark("empty-isolated-project-loaded");
  await client.evaluate(`(() => {
    const textarea = document.querySelector("textarea");
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(textarea, ${JSON.stringify(fixture)});
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: null }));
    return textarea.value.length;
  })()`);
  await waitFor(client, `document.querySelector("textarea").value.length === ${fixture.length}`, "完整文稿输入");
  await client.evaluate(clickButtonExpression("识别角色并继续"));
  await waitFor(client, `document.querySelector('[aria-label="生成任务进度"]')?.innerText.includes("识别文稿角色")`, "右下角角色识别进度");
  await waitFor(client, `document.body.innerText.includes("生成分镜并继续") && document.querySelector('[aria-label="主要角色称呼"]')?.value === "林默" && document.querySelector('[aria-label="第二角色称呼"]')?.value === "苏晴"`, "角色识别");
  await mark("characters-identified");

  await client.evaluate(clickButtonExpression("一键锁定主角母版"));
  await waitFor(client, `(() => { try { return Boolean(JSON.parse(localStorage.getItem("mujing-project-v1")).primaryGeneratedImage); } catch { return false; } })()`, "主角身份母版生成", 60_000);
  await client.evaluate(clickButtonExpression("一键锁定第二角色母版"));
  await waitFor(client, `(() => { try { return Boolean(JSON.parse(localStorage.getItem("mujing-project-v1")).secondaryGeneratedImage); } catch { return false; } })()`, "第二角色身份母版生成", 60_000);
  await mark("character-masters-ready");

  await client.evaluate(clickButtonExpression("生成分镜并继续"));
  await waitFor(client, `document.body.innerText.includes("故事板已经铺开") && (() => { try { return JSON.parse(localStorage.getItem("mujing-project-v1")).shots.length >= 6; } catch { return false; } })()`, "Demo 分镜生成");
  assert.equal(await client.evaluate(`document.body.innerText.includes("生成前确认")`), false, "Demo 不应出现费用确认");
  await client.evaluate(clickButtonExpression("全部确认"));
  await waitFor(client, `document.body.innerText.includes("已全部确认")`, "确认所有分镜");
  await client.evaluate(clickButtonExpression("进入画面生成"));
  await waitFor(client, `document.body.innerText.includes("生成全部图片")`, "进入生成页");
  await mark("storyboard-approved");

  await client.evaluate(clickButtonExpression("生成全部图片"));
  await waitFor(client, `document.querySelector('[aria-label="生成任务进度"]')?.innerText.includes("生成分镜图片")`, "右下角批量生图进度");
  await waitFor(client, `(() => { try { const p=JSON.parse(localStorage.getItem("mujing-project-v1")); return p.shots.length>0 && p.shots.every(s=>s.imageState==="ready" && s.imageUrl); } catch { return false; } })()`, "全部图片就绪", 180_000);
  assert.equal(await client.evaluate(`(() => { const total = JSON.parse(localStorage.getItem("mujing-project-v1")).shots.length; return document.querySelector('[aria-label="生成任务进度"]')?.innerText.includes(\`已完成 \${total} / \${total}\`); })()`), true, "批量生图进度应显示完成数量");
  await mark("images-ready-demo-scope-complete");

  const finalProject = await project(client);
  assert.equal(finalProject.script, fixture, "项目中的完整文稿应与 fixture 一致");
  assert.ok(finalProject.shots.every((shot) => shot.approved && shot.imageState === "ready" && shot.imageUrl));
  assert.ok(finalProject.shots.every((shot) => !shot.videoUrl), "Demo 不得用空 videoUrl 冒充完整成片");
  await writeFile(resolve(evidenceDir, "demo-storyboard.json"), `${JSON.stringify(finalProject, null, 2)}\n`, "utf8");
  await writeFile(resolve(evidenceDir, "demo-ui-trace.json"), `${JSON.stringify(trace, null, 2)}\n`, "utf8");
  process.stdout.write(JSON.stringify({ ok: true, shots: finalProject.shots.length, images: finalProject.shots.filter((shot) => shot.imageUrl).length, completeMovieAccepted: false, stage: "images-ready-demo-scope-complete" }));
} catch (error) {
  await writeFile(resolve(evidenceDir, "demo-ui-trace.json"), `${JSON.stringify({ trace, failure: String(error?.stack || error) }, null, 2)}\n`, "utf8");
  throw error;
} finally {
  client.close();
}
