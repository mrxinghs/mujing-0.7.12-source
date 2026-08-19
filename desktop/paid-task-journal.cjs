const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { createIdentitySecretStore, serviceFingerprints } = require("./paid-task-identity.cjs");
const { readPaidVideoFirstFrame } = require("./media-input.cjs");

const RUNNING_STATUSES = new Set(["queued", "running", "in_progress"]);

function isProviderHttpRejection(error) {
  return Boolean(error
    && error.name === "ProviderHttpError"
    && error.code === "PROVIDER_HTTP_REJECTED"
    && error.definitiveRejection === true
    && Number.isInteger(error.status)
    && error.status >= 100
    && error.status <= 599);
}

function requiredIdentity(payload) {
  const { projectId, shotId } = requiredProjectShot(payload);
  const provider = String(payload?.provider || "").trim();
  if (!provider) throw new Error("付费任务缺少稳定的服务商标识，已阻止提交。");
  return { projectId, shotId, provider };
}

function requiredProjectShot(payload) {
  const projectId = String(payload?.projectId || "").trim();
  const shotId = String(payload?.shotId || "").trim();
  if (!projectId || !shotId) throw new Error("付费任务缺少稳定的项目或镜头标识，已阻止操作。");
  return { projectId, shotId };
}

function fallbackImageDigest(payload) {
  const preparedDigest = String(payload?.firstFrameInput?.digest || "").trim();
  if (preparedDigest) return preparedDigest;
  return readPaidVideoFirstFrame("", payload?.imageUrl).digest;
}

function fingerprintRequest(payload, config = {}) {
  const identity = requiredIdentity(payload);
  const requestOnly = {
    ...identity,
    model: String(config?.videoModel || ""),
    ratio: String(payload?.ratio || ""),
    duration: Number(payload?.duration || 0),
    resolution: String(payload?.resolution || ""),
    imageRole: payload?.imageRole === "first_frame" ? "first_frame" : "reference_image",
    generateAudio: payload?.generateAudio === true,
    prompt: String(payload?.prompt || ""),
    imageDigest: fallbackImageDigest(payload),
  };
  return crypto.createHash("sha256").update(JSON.stringify(requestOnly)).digest("hex");
}

function emptyState() {
  return { version: 1, entries: {} };
}

function createPaidTaskJournal(journalPath, options = {}) {
  const io = options.fs || fs;
  const now = options.now || (() => new Date().toISOString());
  const backupPath = `${journalPath}.bak`;
  const injectedSecret = options.identitySecret === undefined ? null : Buffer.from(options.identitySecret);
  const secretStore = injectedSecret ? null : createIdentitySecretStore(
    options.identitySecretPath || path.join(path.dirname(journalPath), "paid-task-identity.secret"),
    { fs: io, randomBytes: options.randomBytes },
  );

  if (injectedSecret && injectedSecret.length !== 32) throw new Error("测试注入的付费任务身份 secret 必须是 32 字节。");

  function parseFile(filePath) {
    const parsed = JSON.parse(io.readFileSync(filePath, "utf8"));
    if (!parsed || parsed.version !== 1 || typeof parsed.entries !== "object") throw new Error("journal schema is invalid");
    return parsed;
  }

  function read() {
    try { return parseFile(journalPath); }
    catch (error) {
      if (io.existsSync(backupPath)) {
        try { return parseFile(backupPath); }
        catch { /* Report the primary read error below. */ }
      }
      if (error?.code === "ENOENT") return emptyState();
      throw new Error(`付费任务记录无法读取，已阻止提交：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function identitySecret() {
    if (injectedSecret) return injectedSecret;
    const hasDurableIdentity = Object.keys(read().entries).length > 0;
    return secretStore.load({ allowCreate: !hasDurableIdentity });
  }

  function serviceIdentityFor(config = {}) {
    return serviceFingerprints(config, identitySecret());
  }

  function identityFor(payload, config = {}) {
    const identity = requiredIdentity(payload);
    const requestFingerprint = fingerprintRequest(payload, config);
    const imageDigest = fallbackImageDigest(payload);
    const serviceIdentity = serviceIdentityFor(config);
    const key = crypto.createHash("sha256").update([
      identity.projectId,
      identity.shotId,
      identity.provider,
      serviceIdentity.endpointFingerprint,
      serviceIdentity.accountFingerprint,
      requestFingerprint,
    ].join("\n")).digest("hex");
    return { ...identity, ...serviceIdentity, requestFingerprint, imageDigest, key };
  }

  function atomicWrite(state) {
    io.mkdirSync(path.dirname(journalPath), { recursive: true });
    const temporaryPath = `${journalPath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    let descriptor;
    try {
      descriptor = io.openSync(temporaryPath, "wx", 0o600);
      io.writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      io.fsyncSync(descriptor);
      io.closeSync(descriptor);
      descriptor = undefined;
      try {
        io.renameSync(temporaryPath, journalPath);
      } catch (error) {
        if (!io.existsSync(journalPath) || !["EEXIST", "EPERM", "EACCES"].includes(error?.code)) throw error;
        if (io.existsSync(backupPath)) io.unlinkSync(backupPath);
        io.renameSync(journalPath, backupPath);
        try {
          io.renameSync(temporaryPath, journalPath);
          io.unlinkSync(backupPath);
        } catch (replaceError) {
          if (!io.existsSync(journalPath) && io.existsSync(backupPath)) io.renameSync(backupPath, journalPath);
          throw replaceError;
        }
      }
    } catch (error) {
      if (descriptor !== undefined) {
        try { io.closeSync(descriptor); } catch { /* Best effort close. */ }
      }
      try { if (io.existsSync(temporaryPath)) io.unlinkSync(temporaryPath); } catch { /* Keep the original write failure. */ }
      throw new Error(`付费任务记录无法原子保存，已阻止提交：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function updateEntry(key, updater) {
    const state = read();
    const nextEntry = updater(state.entries[key]);
    state.entries[key] = nextEntry;
    atomicWrite(state);
    return nextEntry;
  }

  function findLatestForShot(payload) {
    const { projectId, shotId } = requiredProjectShot(payload);
    return Object.values(read().entries)
      .filter((entry) => entry.projectId === projectId && entry.shotId === shotId)
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)) || Number(right.attempt || 0) - Number(left.attempt || 0))[0];
  }

  function findTask(payload) {
    const { projectId, shotId } = requiredProjectShot(payload);
    const taskId = String(payload?.jobId || payload?.taskId || "").trim();
    if (!taskId) return null;
    const matches = Object.values(read().entries).filter((entry) => entry.projectId === projectId && entry.shotId === shotId && String(entry.taskId || "") === taskId);
    return matches.length === 1 ? matches[0] : null;
  }

  function serviceIdentityMatches(entry, identity) {
    return Boolean(entry
      && entry.endpointFingerprint
      && entry.accountFingerprint
      && entry.endpointFingerprint === identity.endpointFingerprint
      && entry.accountFingerprint === identity.accountFingerprint);
  }

  function findMatchingRequest(payload, config = {}) {
    const identity = identityFor(payload, config);
    const entry = Object.values(read().entries)
      .filter((candidate) => candidate.projectId === identity.projectId
        && candidate.shotId === identity.shotId
        && candidate.provider === identity.provider
        && candidate.requestFingerprint === identity.requestFingerprint
        && serviceIdentityMatches(candidate, identity))
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)) || Number(right.attempt || 0) - Number(left.attempt || 0))[0];
    return { identity, entry: entry || null };
  }

  function findUncertainForShot(payload) {
    const { projectId, shotId } = requiredProjectShot(payload);
    return Object.values(read().entries).find((entry) => entry.projectId === projectId
      && entry.shotId === shotId
      && !String(entry.taskId || "").trim()
      && ["submission_pending", "unknown"].includes(entry.status)) || null;
  }

  function recordSubmissionIntent(payload, config = {}, details = {}) {
    const identity = identityFor(payload, config);
    const timestamp = now();
    const state = read();
    const matching = Object.entries(state.entries)
      .filter(([, candidate]) => candidate.projectId === identity.projectId
        && candidate.shotId === identity.shotId
        && candidate.provider === identity.provider
        && candidate.requestFingerprint === identity.requestFingerprint
        && serviceIdentityMatches(candidate, identity))
      .sort(([, left], [, right]) => String(right.updatedAt).localeCompare(String(left.updatedAt)) || Number(right.attempt || 0) - Number(left.attempt || 0));
    const prior = matching[0]?.[1];
    const attempt = Math.max(0, ...matching.map(([, entry]) => Number(entry.attempt || 0))) + 1;
    let entryKey = identity.key;
    if (prior && ["unknown", "rejected", "abandoned", "failed", "canceled"].includes(prior.status)) {
      entryKey = `${identity.key}:attempt:${attempt}`;
      let collision = 1;
      while (state.entries[entryKey]) {
        entryKey = `${identity.key}:attempt:${attempt}:${collision}`;
        collision += 1;
      }
    }
    const previousTaskIds = [...new Set([prior?.taskId, ...(prior?.previousTaskIds || []), ...(details.previousTaskIds || [])].filter(Boolean))];
    const entry = {
      projectId: identity.projectId,
      shotId: identity.shotId,
      provider: identity.provider,
      endpointFingerprint: identity.endpointFingerprint,
      accountFingerprint: identity.accountFingerprint,
      requestFingerprint: identity.requestFingerprint,
      imageDigest: identity.imageDigest,
      status: "submission_pending",
      taskId: null,
      submittedAt: timestamp,
      updatedAt: timestamp,
      attempt,
      ...(previousTaskIds.length ? { previousTaskIds } : {}),
    };
    state.entries[entryKey] = entry;
    atomicWrite(state);
    return { identity: { ...identity, key: entryKey }, entry };
  }

  function markUnknown(identity, reason) {
    return updateEntry(identity.key, (entry) => ({
      ...entry,
      status: "unknown",
      taskId: null,
      updatedAt: now(),
      failure: reason === "missing-task-id" ? "missing-task-id" : "transport-or-response-error",
    }));
  }

  function markRejected(identity, error) {
    return updateEntry(identity.key, (entry) => ({
      ...entry,
      status: "rejected",
      taskId: null,
      updatedAt: now(),
      failure: "provider-http-rejected",
      httpStatus: Number(error.status),
      ...(error.providerCode ? { providerCode: String(error.providerCode) } : {}),
      ...(error.requestId ? { requestId: String(error.requestId) } : {}),
    }));
  }

  function recordTaskId(identity, result) {
    const taskId = String(result?.jobId || "").trim();
    if (!taskId) throw new Error("服务商没有返回可持久化的任务 ID。");
    const state = read();
    const entry = state.entries[identity.key];
    if (!entry) throw new Error("付费任务提交意图记录不存在，已阻止保存不完整的任务身份。");
    const recordedTaskId = String(entry.taskId || "").trim();
    if (recordedTaskId && recordedTaskId !== taskId) {
      state.entries[identity.key] = {
        ...entry,
        status: "conflict",
        updatedAt: now(),
        failure: "task-id-conflict",
        previousTaskIds: [...new Set([...(entry.previousTaskIds || []), recordedTaskId, taskId])],
      };
      atomicWrite(state);
      throw new Error("检测到付费任务 ID 冲突；已保留全部任务 ID 供人工核查，并阻止继续操作。");
    }
    state.entries[identity.key] = {
      ...entry,
      status: "active",
      taskId,
      remoteStatus: String(result?.status || "queued"),
      updatedAt: now(),
      failure: undefined,
    };
    atomicWrite(state);
    return state.entries[identity.key];
  }

  function markPollResult(payload, result) {
    const taskId = String(payload?.jobId || result?.jobId || "").trim();
    if (!taskId) return null;
    const { projectId, shotId } = requiredProjectShot(payload);
    const state = read();
    const provider = String(payload?.provider || "").trim();
    const pairs = Object.entries(state.entries).filter(([, entry]) => entry.projectId === projectId
      && entry.shotId === shotId
      && entry.taskId === taskId
      && (!provider || entry.provider === provider));
    const pair = pairs.length === 1 ? pairs[0] : null;
    if (!pair) return null;
    const [key] = pair;
    const remoteStatus = String(result?.status || "unknown");
    const completed = ["succeeded", "completed"].includes(remoteStatus) && Boolean(result?.filename);
    const status = completed ? "completed" : RUNNING_STATUSES.has(remoteStatus) ? "active" : remoteStatus === "canceled" ? "canceled" : "failed";
    return updateEntry(key, (entry) => ({
      ...entry,
      status,
      remoteStatus,
      updatedAt: now(),
      ...(completed ? { localResultSavedAt: now() } : {}),
    }));
  }

  function list(projectId) {
    return Object.values(read().entries).filter((entry) => entry.projectId === String(projectId || ""));
  }

  function abandonShot(payload) {
    const { projectId, shotId } = requiredProjectShot(payload);
    const state = read();
    const timestamp = now();
    let count = 0;
    let remoteMayContinue = false;
    for (const [key, entry] of Object.entries(state.entries)) {
      if (entry.projectId !== projectId || entry.shotId !== shotId) continue;
      const alreadyTerminal = ["rejected", "failed", "canceled", "abandoned"].includes(entry.status)
        || (entry.status === "completed" && entry.localResultSavedAt);
      if (alreadyTerminal) continue;
      remoteMayContinue ||= Boolean(entry.taskId) || ["submission_pending", "unknown"].includes(entry.status);
      state.entries[key] = {
        ...entry,
        status: "abandoned",
        abandonedAt: timestamp,
        updatedAt: timestamp,
        failure: "user-abandoned-local-wait",
      };
      count += 1;
    }
    if (count) atomicWrite(state);
    return { abandoned: count > 0, count, remoteMayContinue };
  }

  return {
    abandonShot,
    findLatestForShot,
    findMatchingRequest,
    findUncertainForShot,
    findTask,
    identityFor,
    list,
    markPollResult,
    markRejected,
    markUnknown,
    read,
    recordSubmissionIntent,
    recordTaskId,
    serviceIdentityFor,
    serviceIdentityMatches,
  };
}

function uncertainSubmissionError() {
  return new Error("服务商可能已受理上一次付费请求，但本机没有可靠任务 ID。为避免重复计费，已阻止自动再次提交；只能在获得主进程原生确认授权后重新提交。");
}

function changedRequestError() {
  return new Error("当前镜头输入已改变，不能恢复旧付费任务，也不会自动新建任务。请先恢复旧任务，或申请主进程原生授权后明确重提。");
}

function changedServiceIdentityError() {
  return new Error("当前 Endpoint 或账户与原付费任务记录不一致，已阻止请求。请恢复原 Endpoint/账户或先核查任务。");
}

function createPaidTaskManager({ journal, submitTask, pollTask, preflightTask, resubmitAuthorizer }) {
  const activeSubmissions = new Map();

  function submissionLockKey(payload) {
    const { projectId, shotId } = requiredProjectShot(payload);
    return `${projectId}\n${shotId}`;
  }

  function prepareRequest(payload, mediaDir) {
    requiredIdentity(payload);
    const firstFrameInput = readPaidVideoFirstFrame(mediaDir, payload?.imageUrl, { includeDimensions: payload?.enforceAspect === true });
    const prepared = { ...payload, firstFrameInput };
    delete prepared.imageUrl;
    delete prepared.authorizationToken;
    delete prepared.confirmations;
    return prepared;
  }

  function contextFor(identity) {
    return Object.fromEntries(["projectId", "shotId", "provider", "endpointFingerprint", "accountFingerprint", "requestFingerprint"]
      .map((field) => [field, identity[field]]));
  }

  function withSubmissionLock(identity, payload, operation) {
    const lockKey = submissionLockKey(payload);
    const active = activeSubmissions.get(lockKey);
    if (active) {
      return active.promise.then((result) => {
        if (active.identity.key !== identity.key) throw changedRequestError();
        return { ...result, recovered: true };
      });
    }

    const record = { identity, promise: null };
    const promise = Promise.resolve()
      .then(() => operation(identity))
      .finally(() => {
        if (activeSubmissions.get(lockKey) === record) activeSubmissions.delete(lockKey);
      });
    record.promise = promise;
    activeSubmissions.set(lockKey, record);
    return promise;
  }

  function resolveTaskPair(payload, config) {
    requiredProjectShot(payload);
    const requestedTaskId = String(payload?.jobId || "").trim();
    if (!requestedTaskId) throw new Error("付费任务记录中没有可恢复的任务 ID；已阻止轮询和重新提交。");
    const exactEntry = journal.findTask(payload);
    if (!exactEntry) throw new Error("该任务 ID 未与当前项目和镜头的付费记录绑定，或任务 ID 不匹配；已阻止轮询。");
    const jobId = String(exactEntry.taskId || "").trim();
    const provider = String(exactEntry.provider || "").trim();
    if (!provider) throw new Error("旧项目缺少原服务商，无法安全轮询。已阻止向当前任意服务商发送请求。");
    if (exactEntry.status === "conflict") throw new Error("付费任务记录存在任务 ID 冲突；请先人工核查，已阻止轮询。");
    if (exactEntry.status === "abandoned") throw new Error("该付费任务已由你放弃本地等待并解除锁定；不会再次自动轮询。");
    if (config) {
      const currentServiceIdentity = journal.serviceIdentityFor(config);
      if (!journal.serviceIdentityMatches(exactEntry, currentServiceIdentity)) throw changedServiceIdentityError();
    }
    return { jobId, provider, entry: exactEntry };
  }

  async function submit(config, payload, mediaDir) {
    const prepared = prepareRequest(payload, mediaDir);
    await preflightTask?.(config, prepared, mediaDir);
    const identity = journal.identityFor(prepared, config);
    return withSubmissionLock(identity, prepared, async () => {
      const matching = journal.findMatchingRequest(prepared, config);
      const existing = matching.entry;
      if (existing?.status === "conflict") throw new Error("付费任务记录存在任务 ID 冲突；请先人工核查，已阻止提交。");
      if (existing?.taskId && existing.status !== "abandoned") return { jobId: existing.taskId, status: existing.remoteStatus || "queued", recovered: true };
      if (existing && ["submission_pending", "unknown"].includes(existing.status)) throw uncertainSubmissionError();
      if (journal.findUncertainForShot(prepared)) throw uncertainSubmissionError();
      const latest = journal.findLatestForShot(prepared);
      if (latest && !journal.serviceIdentityMatches(latest, identity)) throw changedServiceIdentityError();
      if (latest && !["rejected", "abandoned", "failed", "canceled"].includes(latest.status)) throw changedRequestError();

      const submission = journal.recordSubmissionIntent(prepared, config);
      const attemptIdentity = submission.identity;
      let result;
      try {
        result = await submitTask(config, prepared, mediaDir);
      } catch (error) {
        if (isProviderHttpRejection(error)) {
          journal.markRejected(attemptIdentity, error);
          throw error;
        }
        journal.markUnknown(attemptIdentity, "transport-or-response-error");
        throw uncertainSubmissionError();
      }
      if (!String(result?.jobId || "").trim()) {
        journal.markUnknown(attemptIdentity, "missing-task-id");
        throw uncertainSubmissionError();
      }
      journal.recordTaskId(attemptIdentity, result);
      return { jobId: result.jobId, status: result.status || "queued", recovered: false };
    });
  }

  async function requestResubmitAuthorization(config, payload, mediaDir, authorization = {}) {
    if (!resubmitAuthorizer) throw new Error("主进程付费重提授权器不可用，已阻止操作。");
    const prepared = prepareRequest(payload, mediaDir);
    await preflightTask?.(config, prepared, mediaDir);
    const identity = journal.identityFor(prepared, config);
    const notice = {
      title: "确认放弃旧记录并付费重提",
      message: `服务商：${identity.provider}\n镜头：${identity.shotId}\n这会放弃旧任务记录的自动恢复路径；旧远端任务可能继续运行并计费，本次重提会产生新增费用。`,
    };
    return resubmitAuthorizer.request({
      senderId: authorization.senderId,
      context: contextFor(identity),
      confirm: authorization.confirm,
      notice,
    });
  }

  async function resubmit(config, payload, mediaDir, authorization = {}) {
    if (!resubmitAuthorizer) throw new Error("缺少主进程签发的付费重提授权 token，已阻止新增 POST。");
    const prepared = prepareRequest(payload, mediaDir);
    await preflightTask?.(config, prepared, mediaDir);
    const identity = journal.identityFor(prepared, config);
    resubmitAuthorizer.consume({ senderId: authorization.senderId, token: authorization.token, context: contextFor(identity) });
    return withSubmissionLock(identity, prepared, async () => {
      const previousTaskIds = journal.list(identity.projectId)
        .filter((entry) => entry.shotId === identity.shotId)
        .flatMap((entry) => [entry.taskId, ...(entry.previousTaskIds || [])])
        .filter(Boolean);
      const submission = journal.recordSubmissionIntent(prepared, config, { previousTaskIds });
      const attemptIdentity = submission.identity;
      let result;
      try {
        result = await submitTask(config, prepared, mediaDir);
      } catch (error) {
        if (isProviderHttpRejection(error)) {
          journal.markRejected(attemptIdentity, error);
          throw error;
        }
        journal.markUnknown(attemptIdentity, "transport-or-response-error");
        throw uncertainSubmissionError();
      }
      if (!String(result?.jobId || "").trim()) {
        journal.markUnknown(attemptIdentity, "missing-task-id");
        throw uncertainSubmissionError();
      }
      journal.recordTaskId(attemptIdentity, result);
      return { jobId: result.jobId, status: result.status || "queued", recovered: false };
    });
  }

  async function poll(config, payload, mediaDir, onProgress) {
    const pair = resolveTaskPair(payload, config);
    const { jobId, provider } = pair;
    const result = await pollTask(config, { ...payload, provider, jobId }, mediaDir, onProgress);
    journal.markPollResult({ ...payload, provider, jobId }, result);
    return result;
  }

  return { abandon: (payload) => journal.abandonShot(payload), list: (projectId) => journal.list(projectId), poll, requestResubmitAuthorization, resolveTaskPair, resubmit, submit };
}

module.exports = { createPaidTaskJournal, createPaidTaskManager, fingerprintRequest };
