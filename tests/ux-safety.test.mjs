import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

test("creation copy follows 文稿 → 角色 → 分镜 and blocks placeholder roles", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /识别角色并继续/);
  assert.match(page, /生成分镜并继续/);
  assert.match(page, /PLACEHOLDER_CHARACTER_NAMES/);
  assert.match(page, /角色称呼不能为空，也不能使用“主要人物”或“第二角色”等占位名称/);
  assert.match(page, /setActiveStep\(2\)/);
  assert.match(page, /characterNameInput[^\n]*current\?\.focus/);
  assert.match(page, /角色称呼不能重复/);
});

test("paid generation entry points disclose provider, uploads, cancellation and billing uncertainty", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /生成前确认/);
  assert.match(page, /暂时无法准确计算费用，请以服务商最终账单为准/);
  assert.match(page, /<dt>模型<\/dt>/);
  assert.match(page, /<dt>生成项<\/dt>/);
  assert.match(page, /提交后通常无法取消/);
  assert.match(page, /失败任务是否计费由服务商决定/);
  assert.match(page, /将上传/);
  assert.match(page, />返回修改</);
  assert.match(page, />确认生成</);
  assert.match(page, /if \(!generationAcknowledged\) return/);
  assert.ok((page.match(/appSettings\.mode === "live" && !noticeConfirmed/g) || []).length >= 4, "每类真实生成入口都必须先经过确认");
});

test("autosave reports time and failure with an explicit retry", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /已自动保存 · /);
  assert.match(page, /保存失败 · 点击重试/);
  assert.match(page, /存在未保存修改/);
  assert.match(page, /retrySave/);
  assert.match(page, />重试保存</);
});

test("clear is confirmed and can be undone once in the current session", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /清空解说文稿会移除当前全部文字/);
  assert.match(page, /window\.confirm/);
  assert.match(page, /undoClearedScript/);
  assert.match(page, /撤销清空/);
  assert.match(page, /清空全部分镜/);
  assert.match(page, /confirmClearStoryboard/);
});

test("finished-video export has a disabled reason and data boundaries are visible", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /exportBlockReason/);
  assert.match(page, /aria-describedby="export-disabled-reason"/);
  assert.match(page, /数据与费用说明/);
  assert.match(page, /项目草稿保存在当前 Windows 用户的应用本地存储中/);
  assert.match(page, /主动清理/);
});

test("shot queue exposes all states, local retry and cancellation without regenerating successes", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /"idle" \| "submitting" \| "generating" \| "downloading" \| "ready" \| "error" \| "canceled"/);
  assert.match(page, /取消尚未提交镜头/);
  assert.match(page, /单独重试图片/);
  assert.match(page, /继续轮询原任务/);
  assert.match(page, /state !== "ready"/);
  assert.match(page, /videoTaskId/);
});

test("character-dependent image generation is blocked until the protagonist identity master is bound", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /missingCharacterReferencesForShots/);
  assert.match(page, /已暂停生成：请先为/);
  assert.match(page, /身份母版，已暂停生成并打开角色页/);
  assert.match(page, /一键锁定主角母版/);
  assert.match(page, /不得擅自增加兄弟姐妹或其他未提及人物/);
  assert.match(page, /母版身份优先级高于其他画面描述/);
});

test("video task polling reuses task id without another paid POST", async () => {
  const providers = require("../desktop/providers.cjs");
  assert.equal(typeof providers.submitVideoTask, "function");
  assert.equal(typeof providers.pollVideoTask, "function");

  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET" });
    if ((init.method || "GET") === "POST") return new Response(JSON.stringify({ id: "task-paid-once", status: "queued" }), { status: 200 });
    return new Response(JSON.stringify({ id: "task-paid-once", status: "running" }), { status: 200 });
  };
  try {
    const config = { apiKey: "test-only", baseUrl: "https://example.invalid/v1", videoModel: "video-test" };
    const payload = { provider: "Seedance", prompt: "offline test", ratio: "16:9", duration: 4 };
    const submitted = await providers.submitVideoTask(config, payload, "C:\\not-used");
    assert.deepEqual(submitted, { jobId: "task-paid-once", status: "queued" });
    const polled = await providers.pollVideoTask(config, { ...payload, jobId: submitted.jobId }, "C:\\not-used");
    assert.equal(polled.status, "running");
    assert.equal(calls.filter((call) => call.method === "POST").length, 1);
    assert.equal(calls.filter((call) => call.method === "GET" && call.url.includes("task-paid-once")).length, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test("paid task recovery never falls back to the currently selected global video provider", async () => {
  const [page, main] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../desktop/main.cjs", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(page, /videoTaskProvider\s*\|\|\s*providers\.video/);
  assert.doesNotMatch(main, /journalEntry\?\.provider\s*\|\|\s*payload\?\.provider/);
  assert.match(page, /旧项目缺少原服务商，无法安全轮询/);
  assert.match(main, /resolveTaskPair/);
});

test("shot UI exposes every queue state, one-shot retry and explicit paid resubmission", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  for (const label of ["等待生成", "正在提交", "生成中", "下载中", "已完成", "生成失败", "已取消"]) assert.match(page, new RegExp(label));
  assert.match(page, /单独重试/);
  assert.match(page, /重新提交新任务/);
  assert.match(page, /restartVideoTask/);
  assert.match(page, /requestVideoResubmitAuthorization/);
  assert.match(page, /resubmitVideoTask/);
  assert.match(page, /authorizationToken: authorization\.token/);
  assert.doesNotMatch(page, /confirmations: \{ abandonOldRecord: true, additionalCharge: true \}/);
  assert.match(page, /replacementJobId/);
});

test("data notice states actual storage, cache, key, deletion, export and billing boundaries", async () => {
  const [page, main, preload] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../desktop/main.cjs", import.meta.url), "utf8"),
    readFile(new URL("../desktop/preload.cjs", import.meta.url), "utf8"),
  ]);
  assert.match(main, /storage:info/);
  assert.match(preload, /getStorageInfo/);
  assert.match(page, /本地媒体缓存/);
  assert.match(page, /provider-settings\.bin/);
  assert.match(page, /导出的 MP4/);
  assert.match(page, /服务商直接收取/);
});
