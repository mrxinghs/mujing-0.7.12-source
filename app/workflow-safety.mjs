export const PLACEHOLDER_CHARACTER_NAMES = new Set([
  "",
  "主要人物",
  "第二角色",
  "主角",
  "角色",
  "人物",
  "未命名角色",
  "待定角色",
  "角色1",
  "角色2",
  "character",
  "character 1",
  "character 2",
]);

function normalizedName(name) {
  return String(name ?? "").normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("zh-CN");
}

function placeholderComparableName(name) {
  return normalizedName(name).replace(/\s+/g, "");
}

export function validateCharacterNames(characters) {
  const enabled = characters.filter((character) => character.enabled);
  const seen = new Set();
  for (const character of enabled) {
    const name = normalizedName(character.name);
    const placeholderName = placeholderComparableName(character.name);
    const isNumberedPlaceholder = /^(?:新)?角色\d+$/u.test(placeholderName) || /^character\d+$/i.test(placeholderName);
    const isPlaceholder = isNumberedPlaceholder || [...PLACEHOLDER_CHARACTER_NAMES].some((candidate) => placeholderComparableName(candidate) === placeholderName);
    if (isPlaceholder) {
      return {
        ok: false,
        invalidKey: character.key,
        message: "角色称呼不能为空，也不能使用“主要人物”或“第二角色”等占位名称。请填写故事中可辨认的称呼后再生成。",
      };
    }
    if (seen.has(name)) {
      return {
        ok: false,
        invalidKey: character.key,
        message: "两个启用角色的角色称呼不能重复。请为当前角色填写不同、可辨认的称呼后再生成。",
      };
    }
    seen.add(name);
  }
  return { ok: true };
}

export function buildGenerationNotice({ title, model, provider, itemCount, uploads }) {
  return {
    title,
    model: String(model || "未配置"),
    provider: String(provider || "未配置"),
    itemCount: Math.max(1, Number(itemCount) || 1),
    uploads,
    cancellation: "点击确认后才会提交；尚未提交的队列项可安全取消。提交到服务商后通常无法取消，且可能产生费用。",
    failureBilling: "失败任务仍可能计费，是否计费由服务商决定。幕境不会自动重复提交付费任务。",
    billing: "暂时无法准确计算费用，请以服务商最终账单为准。",
  };
}

function safeProviderIdentifier(value, maxLength = 200) {
  const text = typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  return text && text.length <= maxLength && /^[A-Za-z0-9_.:/-]+$/.test(text) ? text : "";
}

export function providerHttpRejectionMessage(status, providerCode, requestId) {
  const numericStatus = Number(status);
  const suffix = Number.isInteger(numericStatus) && numericStatus >= 100 && numericStatus <= 599
    ? `（HTTP ${numericStatus}）`
    : "";
  const code = safeProviderIdentifier(providerCode, 160);
  const request = safeProviderIdentifier(requestId);
  const details = [code ? `错误码 ${code}` : "", request ? `请求 ID ${request}` : ""].filter(Boolean).join("，");
  return `服务商拒绝了请求${suffix}${details ? `，${details}` : ""}。请检查模型权限、请求参数与账户状态后重试。`;
}

export function paidSubmissionRiskFromError(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  return /可能已受理|没有可靠任务 ID|未返回可靠任务 ID|阻止自动再次提交/.test(message);
}

function normalizedDocument(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/g, "");
}

export function getExportBlockReason({ shots = [], script = "", voiceUrl = "" } = {}) {
  if (!shots.length) return "尚未创建分镜";
  const missingVisualIndex = shots.findIndex((shot) => !((shot.videoState === "ready" && String(shot.videoUrl || "").trim()) || (shot.imageState === "ready" && String(shot.imageUrl || "").trim())));
  if (missingVisualIndex >= 0) return `镜头 ${missingVisualIndex + 1} 缺少可用的视频或分镜图片`;
  if (!String(voiceUrl || "").trim()) return "尚未生成完整配音";
  const subtitleText = shots.map((shot) => shot.narration || "").join("");
  if (!normalizedDocument(script) || normalizedDocument(subtitleText) !== normalizedDocument(script)) return "字幕未完整覆盖原文文稿";
  return "";
}

export function videoTaskAction(shot, options = {}) {
  if (shot.videoTaskId && !options.explicitResubmit) {
    const provider = String(shot.videoTaskProvider || "").trim();
    if (!provider) {
      return {
        kind: "blocked",
        reason: "旧项目缺少原服务商，无法安全轮询。请保留任务 ID，并在服务商后台人工核对任务。",
      };
    }
    return { kind: "resume", jobId: shot.videoTaskId, provider };
  }
  return { kind: "submit" };
}

export function hasUnresolvedPaidTask(shot) {
  return Boolean(shot?.videoTaskId) && shot?.videoTaskProvider !== "本地 ComfyUI" && !(shot?.videoState === "ready" && Boolean(shot?.videoUrl));
}

export function isPaidJournalEntryUnresolved(entry) {
  if (!entry) return false;
  if (["rejected", "failed", "canceled", "abandoned"].includes(String(entry.status || ""))) return false;
  if (entry.status === "completed" && entry.localResultSavedAt) return false;
  return true;
}

export function guardPaidTaskDestruction(shots, action, shotId) {
  const shotScopedActions = new Set(["image-regeneration", "first-frame-change", "visual-change"]);
  const relevant = shotScopedActions.has(action) && shotId
    ? shots.filter((shot) => shot.id === shotId)
    : shots;
  const task = relevant.find(hasUnresolvedPaidTask);
  if (!task) return { allowed: true };
  return {
    allowed: false,
    task,
    reason: `镜头 ${task.id} 仍保留未解决的付费任务。请先继续轮询原任务，或明确放弃旧任务并再次确认可能新增的费用；当前操作不会改变旧任务输入。`,
  };
}

export function stopShotLocally(shot) {
  if (!shot?.videoTaskId) {
    return { ...shot, videoState: "canceled", error: "已停止尚未提交的本地镜头队列。" };
  }
  return {
    ...shot,
    videoState: "canceled",
    error: "仅停止本地轮询，远端任务可能继续并计费；任务 ID 已保留，可继续轮询原任务。",
  };
}

export function videoPollingPolicy(provider) {
  const isLocalComfyUI = String(provider || "").trim() === "本地 ComfyUI";
  return {
    intervalMs: isLocalComfyUI ? 3_000 : 10_000,
    // Local Wan video generation can legitimately take well over ten minutes.
    // Keep polling until ComfyUI reaches a terminal state or the user stops it.
    maxAttempts: isLocalComfyUI ? Number.POSITIVE_INFINITY : 120,
  };
}

export async function pollPaidTaskUntilSettled({ poll, wait, shouldStop, maxAttempts = 120 }) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (shouldStop()) return { kind: "stopped" };
    const result = await poll();
    if (shouldStop()) return { kind: "stopped" };
    if (!["queued", "running", "in_progress"].includes(result.status)) return { kind: "settled", result };
    if (attempt < maxAttempts - 1) await wait();
    if (shouldStop()) return { kind: "stopped" };
  }
  return { kind: "timed-out" };
}

function cloneShots(shots) {
  return typeof structuredClone === "function" ? structuredClone(shots) : JSON.parse(JSON.stringify(shots));
}

export function prepareStoryboardClear(shots) {
  const guard = guardPaidTaskDestruction(shots, "storyboard-clear");
  if (!guard.allowed) return guard;
  return { allowed: true, snapshot: cloneShots(shots), nextShots: [] };
}

export function restoreStoryboardSnapshot(snapshot) {
  return cloneShots(snapshot || []);
}

export function assetStateLabel(state) {
  return ({
    idle: "等待生成",
    submitting: "正在提交",
    generating: "生成中",
    downloading: "下载中",
    ready: "已完成",
    error: "生成失败",
    canceled: "已取消",
  })[state] ?? "未知状态";
}
