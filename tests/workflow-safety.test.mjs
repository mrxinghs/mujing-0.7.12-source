import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

async function safety() {
  return import(new URL(`../app/workflow-safety.mjs?test=${Date.now()}-${Math.random()}`, import.meta.url));
}

test("character validation rejects blank, placeholders and duplicates without rejecting real names", async () => {
  const { validateCharacterNames } = await safety();
  assert.equal(validateCharacterNames([{ key: "primary", enabled: true, name: "" }]).invalidKey, "primary");
  assert.equal(validateCharacterNames([{ key: "primary", enabled: true, name: "主要人物" }]).invalidKey, "primary");
  assert.equal(validateCharacterNames([{ key: "secondary", enabled: true, name: "未命名角色" }]).invalidKey, "secondary");
  const duplicate = validateCharacterNames([
    { key: "primary", enabled: true, name: " 林默 " },
    { key: "secondary", enabled: true, name: "林默" },
  ]);
  assert.equal(duplicate.invalidKey, "secondary");
  assert.match(duplicate.message, /不能重复/);
  assert.deepEqual(validateCharacterNames([
    { key: "primary", enabled: true, name: "林默" },
    { key: "secondary", enabled: true, name: "林墨" },
  ]), { ok: true });

  for (const placeholder of ["角色 1", "角色   2", "角色　１", "角 色 ２", "ｃｈａｒａｃｔｅｒ　１"]) {
    assert.equal(validateCharacterNames([{ key: "primary", enabled: true, name: placeholder }]).invalidKey, "primary", placeholder);
  }
  assert.deepEqual(validateCharacterNames([{ key: "primary", enabled: true, name: "角色设计师林默" }]), { ok: true });
});

test("generation confirmation describes model, provider, items, uploads and uncertain billing", async () => {
  const { buildGenerationNotice } = await safety();
  const notice = buildGenerationNotice({ title: "生成视频镜头", model: "video-model", provider: "Seedance", itemCount: 3, uploads: "3 张首帧图片" });
  assert.equal(notice.model, "video-model");
  assert.equal(notice.provider, "Seedance");
  assert.equal(notice.itemCount, 3);
  assert.match(notice.billing, /暂时无法准确计算费用，请以服务商最终账单为准/);
  assert.match(notice.cancellation, /尚未提交/);
  assert.match(notice.failureBilling, /可能计费/);
});

test("export reason gives exact missing prerequisites", async () => {
  const { getExportBlockReason } = await safety();
  const completeShot = { id: "shot-01", videoState: "ready", videoUrl: "http://localhost/__media/shot-01.mp4", narration: "完整文稿。" };
  assert.equal(getExportBlockReason({ shots: [], script: "完整文稿。", voiceUrl: "voice.wav" }), "尚未创建分镜");
  assert.equal(getExportBlockReason({ shots: [{ ...completeShot, videoUrl: "" }], script: "完整文稿。", voiceUrl: "voice.wav" }), "镜头 1 缺少可用的视频或分镜图片");
  assert.equal(getExportBlockReason({ shots: [{ ...completeShot, videoState: "generating" }], script: "完整文稿。", voiceUrl: "voice.wav" }), "镜头 1 缺少可用的视频或分镜图片");
  assert.equal(getExportBlockReason({ shots: [{ ...completeShot, videoState: "error", videoUrl: "", imageState: "ready", imageUrl: "http://localhost/__media/shot-01.jpg" }], script: "完整文稿。", voiceUrl: "voice.wav" }), "");
  assert.equal(getExportBlockReason({ shots: [completeShot], script: "完整文稿。", voiceUrl: "" }), "尚未生成完整配音");
  assert.equal(getExportBlockReason({ shots: [{ ...completeShot, narration: "不完整。" }], script: "完整文稿。", voiceUrl: "voice.wav" }), "字幕未完整覆盖原文文稿");
  assert.equal(getExportBlockReason({ shots: [completeShot], script: "完整文稿。", voiceUrl: "voice.wav" }), "");
});

test("script typing, import, and clear all invalidate renderer voice state immediately", async () => {
  const { getExportBlockReason } = await safety();
  const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /function updateScript\(/);
  assert.match(page, /onChange=\{\(event\) => updateScript\(event\.target\.value/);
  assert.match(page, /function importScript[\s\S]*updateScript\(String\(reader\.result/);
  assert.match(page, /function clearScript[\s\S]*updateScript\(""/);
  assert.match(page, /setVoiceUrl\(""\)/);
  assert.notEqual(getExportBlockReason({ shots: [{ videoState: "ready", videoUrl: "video.mp4", narration: "新文稿。" }], script: "新文稿。", voiceUrl: "" }), "");
});

test("task action always resumes an existing id unless the user explicitly resubmits", async () => {
  const { videoTaskAction } = await safety();
  assert.deepEqual(videoTaskAction({ videoTaskId: "paid-task", videoTaskProvider: "Seedance" }), { kind: "resume", jobId: "paid-task", provider: "Seedance" });
  const missingProvider = videoTaskAction({ videoTaskId: "paid-task" });
  assert.equal(missingProvider.kind, "blocked");
  assert.match(missingProvider.reason, /旧项目缺少原服务商，无法安全轮询/);
  assert.deepEqual(videoTaskAction({ videoTaskId: "paid-task" }, { explicitResubmit: true }), { kind: "submit" });
  assert.deepEqual(videoTaskAction({}), { kind: "submit" });
});

test("shot state labels cover the full safe queue lifecycle", async () => {
  const { assetStateLabel } = await safety();
  assert.deepEqual(["idle", "submitting", "generating", "downloading", "ready", "error", "canceled"].map(assetStateLabel), [
    "等待生成", "正在提交", "生成中", "下载中", "已完成", "生成失败", "已取消",
  ]);
});

test("only genuinely unresolved main-process journal states keep the editing lock", async () => {
  const { isPaidJournalEntryUnresolved } = await safety();
  for (const status of ["active", "submission_pending", "unknown", "conflict"]) assert.equal(isPaidJournalEntryUnresolved({ status }), true, status);
  assert.equal(isPaidJournalEntryUnresolved({ status: "completed" }), true);
  assert.equal(isPaidJournalEntryUnresolved({ status: "completed", localResultSavedAt: "now" }), false);
  for (const status of ["rejected", "failed", "canceled", "abandoned"]) assert.equal(isPaidJournalEntryUnresolved({ status }), false, status);
});

test("style, image regeneration, clear and redesign are blocked while a paid task remains recoverable", async () => {
  const { guardPaidTaskDestruction, videoTaskAction } = await safety();
  const shot = { id: "shot-01", videoTaskId: "paid-running", videoTaskProvider: "Seedance", videoState: "error", imageState: "ready" };
  for (const action of ["style-change", "image-regeneration", "storyboard-clear", "storyboard-redesign"]) {
    const result = guardPaidTaskDestruction([shot], action, "shot-01");
    assert.equal(result.allowed, false, action);
    assert.match(result.reason, /继续轮询原任务|付费任务/);
  }
  assert.deepEqual(videoTaskAction(shot), { kind: "resume", jobId: "paid-running", provider: "Seedance" });
});

test("visual, first-frame, style, ratio and character changes are blocked for unresolved paid inputs", async () => {
  const { guardPaidTaskDestruction } = await safety();
  const unresolved = { id: "shot-01", videoTaskId: "paid-running", videoTaskProvider: "Seedance", videoState: "error", imageState: "ready" };
  const unrelated = { id: "shot-02", videoState: "idle", imageState: "ready" };
  for (const action of ["visual-change", "first-frame-change", "style-change", "ratio-change", "character-profile-change"]) {
    const result = guardPaidTaskDestruction([unresolved, unrelated], action, "shot-01");
    assert.equal(result.allowed, false, action);
    assert.match(result.reason, /继续轮询原任务.*明确放弃/);
  }
  assert.equal(guardPaidTaskDestruction([unresolved, unrelated], "visual-change", "shot-02").allowed, true);
  assert.equal(guardPaidTaskDestruction([{ ...unresolved, videoState: "ready", videoUrl: "local-video" }], "ratio-change").allowed, true);
});

test("local per-shot stop interrupts polling within one interval and preserves the remote task identity", async () => {
  const { pollPaidTaskUntilSettled, stopShotLocally } = await safety();
  let stopped = false;
  let pollCount = 0;
  const result = await pollPaidTaskUntilSettled({
    maxAttempts: 120,
    shouldStop: () => stopped,
    poll: async () => { pollCount += 1; return { jobId: "paid-running", status: "running" }; },
    wait: async () => { stopped = true; },
  });
  assert.deepEqual(result, { kind: "stopped" });
  assert.equal(pollCount, 1);

  const original = { id: "shot-01", videoTaskId: "paid-running", videoTaskProvider: "Seedance", videoState: "generating" };
  const locallyStopped = stopShotLocally(original);
  assert.equal(locallyStopped.videoTaskId, "paid-running");
  assert.equal(locallyStopped.videoTaskProvider, "Seedance");
  assert.equal(locallyStopped.videoState, "canceled");
  assert.match(locallyStopped.error, /仅停止本地轮询.*远端任务可能继续并计费/);
});

test("local ComfyUI polling has no artificial timeout while cloud polling stays bounded", async () => {
  const { videoPollingPolicy } = await safety();
  assert.deepEqual(videoPollingPolicy("本地 ComfyUI"), {
    intervalMs: 3_000,
    maxAttempts: Number.POSITIVE_INFINITY,
  });
  assert.deepEqual(videoPollingPolicy("Seedance"), {
    intervalMs: 10_000,
    maxAttempts: 120,
  });
});

test("local ComfyUI can outlive the former 120-poll limit and still settle", async () => {
  const { pollPaidTaskUntilSettled, videoPollingPolicy } = await safety();
  let pollCount = 0;
  const policy = videoPollingPolicy("本地 ComfyUI");
  const result = await pollPaidTaskUntilSettled({
    maxAttempts: policy.maxAttempts,
    shouldStop: () => false,
    poll: async () => {
      pollCount += 1;
      return pollCount <= 125
        ? { jobId: "local-long-running", status: "running" }
        : { jobId: "local-long-running", status: "succeeded", url: "local-video.webm" };
    },
    wait: async () => {},
  });
  assert.equal(pollCount, 126);
  assert.deepEqual(result, {
    kind: "settled",
    result: { jobId: "local-long-running", status: "succeeded", url: "local-video.webm" },
  });
});

test("clear storyboard keeps a complete one-session snapshot and never uses undo to bypass unresolved paid tasks", async () => {
  const { prepareStoryboardClear, restoreStoryboardSnapshot } = await safety();
  const unresolved = [{ id: "shot-01", narration: "描述", approved: true, imageUrl: "local-image", videoTaskId: "paid-running", videoTaskProvider: "Seedance", videoState: "generating" }];
  const blocked = prepareStoryboardClear(unresolved);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.snapshot, undefined);

  const completed = [{ ...unresolved[0], videoState: "ready", videoUrl: "local-video" }];
  const cleared = prepareStoryboardClear(completed);
  assert.equal(cleared.allowed, true);
  assert.deepEqual(cleared.nextShots, []);
  completed[0].narration = "mutated after snapshot";
  const restored = restoreStoryboardSnapshot(cleared.snapshot);
  assert.equal(restored[0].narration, "描述");
  assert.equal(restored[0].videoTaskId, "paid-running");
  assert.equal(restored[0].videoTaskProvider, "Seedance");
  assert.equal(restored[0].videoUrl, "local-video");
});
