import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const preload = await readFile(new URL("../desktop/preload.cjs", import.meta.url), "utf8");
const main = await readFile(new URL("../desktop/main.cjs", import.meta.url), "utf8");

test("a blocked paid task offers both safe recovery and an explicit local unlock", () => {
  assert.match(page, /这个视频任务还没有结束/);
  assert.match(page, /继续查询原任务/);
  assert.match(page, /放弃等待并解除锁定/);
  assert.match(page, /处理旧任务 \/ 只解除本机锁/);
  assert.match(page, /付费重新提交新任务/);
  assert.match(page, /Seedance 远端任务可能仍继续运行和计费/);
  assert.match(page, /abandonPaidVideoTask/);
  assert.match(preload, /ai:video-abandon/);
  assert.match(main, /确认放弃并解除锁定/);
  assert.match(main, /这不会向服务商发送取消请求/);
});
