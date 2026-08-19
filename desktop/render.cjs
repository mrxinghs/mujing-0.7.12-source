const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { mediaPathFromUrl } = require("./providers.cjs");
const { detectImageMime, ffmpegPath, probeMediaFile, validateImageBuffer } = require("./media-tools.cjs");
const { verifyVoiceProvenance } = require("./media-provenance.cjs");

const MEDIA_DURATION_TOLERANCE_SECONDS = 0.25;
const MAX_EXPORT_AUDIO_BYTES = 64 * 1024 * 1024;
const MAX_EXPORT_VIDEO_BYTES = 1024 * 1024 * 1024;
const MAX_EXPORT_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_EXPORT_MUSIC_BYTES = 200 * 1024 * 1024;
const MAX_EXPORT_SCRIPT_CODE_POINTS = 100_000;
const MAX_EXPORT_SHOTS = 500;
const MIN_EXPORT_SHOT_DURATION_SECONDS = 0.5;
const MAX_EXPORT_SHOT_DURATION_SECONDS = 300;
const MAX_EXPORT_TOTAL_DURATION_SECONDS = 21_600;
const MAX_EXPORT_SHOT_TEXT_CODE_POINTS = 10_000;
const MAX_EXPORT_URL_CODE_POINTS = 8_192;
const MAX_EXPORT_PROVIDERS = 50;
const MAX_EXPORT_PROVIDER_KEY_CODE_POINTS = 100;
const STAGING_COPY_CHUNK_BYTES = 1024 * 1024;

async function openVerifiedMedia(record, label, role) {
  let handle;
  try {
    handle = await fs.promises.open(record.path, fs.constants.O_RDONLY);
    const before = stableFileIdentity(await handle.stat({ bigint: true }));
    const pathIdentity = stableFileIdentity(await statBigInt(record.path));
    if (!sameFileIdentity(record.identity, before) || !sameFileIdentity(before, pathIdentity)) throw new Error(`${label}暂存副本身份发生变化。`);
    const hashed = await hashOpenFile(handle);
    const after = stableFileIdentity(await handle.stat({ bigint: true }));
    if (!sameFileIdentity(before, after) || hashed.bytes !== record.bytes || hashed.sha256 !== record.sha256) {
      throw new Error(`${label}暂存副本字节发生变化。`);
    }
    return { handle, path: record.path, role, label, expectedBytes: record.bytes, expectedSha256: record.sha256, identity: after };
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error?.code === "ENOENT") throw new Error(`${label}暂存副本不可用。`);
    throw error;
  }
}

async function openGeneratedMedia(filename, label, role) {
  let handle;
  try {
    handle = await fs.promises.open(filename, fs.constants.O_RDONLY);
    const before = stableFileIdentity(await handle.stat({ bigint: true }));
    if (before.size <= 0n) throw new Error(`${label}为空。`);
    const hashed = await hashOpenFile(handle);
    const after = stableFileIdentity(await handle.stat({ bigint: true }));
    if (!sameFileIdentity(before, after) || BigInt(hashed.bytes) !== before.size) throw new Error(`${label}在打开验证时发生变化。`);
    return { handle, path: filename, role, label, expectedBytes: hashed.bytes, expectedSha256: hashed.sha256, identity: after };
  } catch (error) {
    await handle?.close().catch(() => {});
    throw error;
  }
}

async function writeWithBackpressure(writable, chunk) {
  if (writable.destroyed) throw new Error("ffmpeg 输入管道已提前关闭。");
  await new Promise((resolve, reject) => {
    writable.write(chunk, (error) => error ? reject(error) : resolve());
  });
}

async function streamRecord(record, writable) {
  let remainingBytes = record.totalStreamBytes ?? (record.expectedBytes * Math.max(1, Number(record.repeats) || 1));
  const buffer = Buffer.allocUnsafe(STAGING_COPY_CHUNK_BYTES);
  while (remainingBytes > 0) {
    const passBytes = Math.min(record.expectedBytes, remainingBytes);
    const hash = crypto.createHash("sha256");
    let position = 0;
    while (position < passBytes) {
      const requested = Math.min(buffer.length, passBytes - position);
      const { bytesRead } = await record.handle.read(buffer, 0, requested, position);
      if (!bytesRead) break;
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      await writeWithBackpressure(writable, chunk);
      position += bytesRead;
    }
    const actualSha256 = hash.digest("hex");
    const expectedSha256 = passBytes === record.expectedBytes ? record.expectedSha256 : record.expectedPrefixSha256;
    const after = stableFileIdentity(await record.handle.stat({ bigint: true }));
    if (position !== passBytes || !expectedSha256 || actualSha256 !== expectedSha256 || !sameFileIdentity(record.identity, after)) {
      throw new Error(`${record.label}实际输送字节与预期 SHA-256 不一致。`);
    }
    remainingBytes -= passBytes;
  }
}

async function closeInputRecords(inputs) {
  const handles = new Set();
  for (const input of inputs) for (const record of input.records || [input]) handles.add(record.handle);
  await Promise.allSettled([...handles].map((handle) => handle.close()));
}

async function runFfmpegFromHandles(args, inputs, options = {}) {
  if (options.signal?.aborted) {
    await closeInputRecords(inputs);
    throw new Error("ffmpeg 媒体输送已中止。");
  }
  try {
    await options.beforeSpawn?.({ phase: options.phase, inputs: inputs.flatMap((input) => input.records || [input]).map((input) => ({ path: input.path, role: input.role })) });
  } catch (error) {
    await closeInputRecords(inputs);
    throw error;
  }
  let processHandle;
  try {
    processHandle = spawn(ffmpegPath(), args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe", ...inputs.map(() => "pipe")] });
  } catch (error) {
    await closeInputRecords(inputs);
    throw error;
  }
  let errorText = "";
  let settled = false;
  let aborted = false;
  for (const stream of processHandle.stdio.slice(3)) stream?.on("error", () => {});
  const abort = () => {
    aborted = true;
    for (const stream of processHandle.stdio.slice(3)) stream?.destroy();
    if (!settled) processHandle.kill();
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  processHandle.stderr.on("data", (chunk) => { errorText = `${errorText}${chunk}`.slice(-8000); });
  const childDone = new Promise((resolve, reject) => {
    processHandle.once("error", () => reject(new Error("未找到视频渲染组件，请重新安装最新版幕境。")));
    processHandle.once("close", (code) => {
      settled = true;
      if (code === 0) resolve();
      else reject(new Error(`视频渲染失败（${code}）：${errorText.slice(-900)}`));
    });
  });
  const transfers = inputs.map(async (input, index) => {
    const writable = processHandle.stdio[index + 3];
    try {
      for (const record of input.records || [input]) await streamRecord(record, writable);
      writable.end();
      if (!writable.writableFinished && !writable.destroyed) await once(writable, "finish");
    } catch (error) {
      writable.destroy();
      throw new Error(`${input.role || "媒体"}管道输送失败：${error instanceof Error ? error.message : String(error)}`);
    }
  });
  try {
    await Promise.all([childDone, ...transfers]);
  } catch (error) {
    for (const stream of processHandle.stdio.slice(3)) stream?.destroy();
    if (!settled) processHandle.kill();
    await Promise.allSettled([childDone, ...transfers]);
    if (aborted) throw new Error("ffmpeg 媒体输送已中止。");
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", abort);
    await closeInputRecords(inputs);
  }
}

function srtTime(seconds) {
  const safe = Math.max(0, seconds);
  const hours = Math.floor(safe / 3600).toString().padStart(2, "0");
  const minutes = Math.floor((safe % 3600) / 60).toString().padStart(2, "0");
  const secs = Math.floor(safe % 60).toString().padStart(2, "0");
  const millis = Math.floor((safe % 1) * 1000).toString().padStart(3, "0");
  return `${hours}:${minutes}:${secs},${millis}`;
}

function normalizedDocument(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/g, "");
}

function isDataUrl(value) {
  return /^data:/i.test(String(value || "").trim());
}

function codePointLength(value) {
  let count = 0;
  for (const character of value) count += character.length > 0 ? 1 : 0;
  return count;
}

function assertPlainDataObject(value, label) {
  if (!value || typeof value !== "object" || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new Error(`${label}必须是普通对象。`);
  }
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (descriptor.get || descriptor.set) throw new Error(`${label}不能包含 getter/setter。`);
  }
}

function assertDenseArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label}必须是数组。`);
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) throw new Error(`${label}不能是稀疏数组（缺少索引 ${index}）。`);
  }
}

function assertBoundedString(value, label, maxCodePoints, { required = false } = {}) {
  if (value === undefined && !required) return 0;
  if (typeof value !== "string") throw new Error(`${label}必须是字符串。`);
  const actual = codePointLength(value);
  if (actual > maxCodePoints) throw new Error(`${label}最多 ${maxCodePoints} 个 Unicode 字符，实际 ${actual}。`);
  if (required && !value.trim()) throw new Error(`${label}不能为空。`);
  return actual;
}

function validateCompleteRenderPayload(payload) {
  assertPlainDataObject(payload, "导出参数");
  assertBoundedString(payload.script, "文稿", MAX_EXPORT_SCRIPT_CODE_POINTS, { required: true });
  assertDenseArray(payload.shots, "镜头数组");
  if (!payload.shots.length) throw new Error("项目中没有可导出的镜头（至少需要 1 个）。");
  if (payload.shots.length > MAX_EXPORT_SHOTS) throw new Error(`完整导出最多 ${MAX_EXPORT_SHOTS} 个镜头，实际 ${payload.shots.length}。`);
  if (typeof payload.voiceUrl !== "string" || !payload.voiceUrl.trim()) throw new Error("尚未生成完整配音，已阻止完整成片导出。");
  if (isDataUrl(payload.voiceUrl)) throw new Error("完整导出不接受配音 data URL，请先保存到主进程受控媒体库。");
  assertBoundedString(payload.voiceUrl, "完整配音地址", MAX_EXPORT_URL_CODE_POINTS, { required: true });
  assertBoundedString(payload.musicUrl, "背景音乐地址", MAX_EXPORT_URL_CODE_POINTS);

  if (payload.characters !== undefined) {
    assertDenseArray(payload.characters, "角色数组");
    if (payload.characters.length > 100) throw new Error(`完整导出最多 100 个角色，实际 ${payload.characters.length}。`);
    for (const [index, character] of payload.characters.entries()) {
      assertPlainDataObject(character, `角色 ${index + 1}`);
      for (const key of ["id", "name", "description", "referenceImage", "generatedImage"]) {
        assertBoundedString(character[key], `角色 ${index + 1} 的 ${key}`, key.includes("Image") ? MAX_EXPORT_URL_CODE_POINTS : MAX_EXPORT_SHOT_TEXT_CODE_POINTS);
      }
    }
  }
  if (payload.providers !== undefined) {
    assertPlainDataObject(payload.providers, "provider 配置");
    const keys = Reflect.ownKeys(payload.providers);
    if (keys.length > MAX_EXPORT_PROVIDERS) throw new Error(`provider 配置最多 ${MAX_EXPORT_PROVIDERS} 项，实际 ${keys.length}。`);
    for (const key of keys) {
      if (typeof key !== "string") throw new Error("provider 配置键必须是字符串。");
      assertBoundedString(key, "provider 配置键", MAX_EXPORT_PROVIDER_KEY_CODE_POINTS, { required: true });
      if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error(`provider 配置包含危险保留键 ${key}。`);
      if (!/^[\p{L}\p{N}_.-]+$/u.test(key)) throw new Error(`provider 配置键 ${key} 包含不安全字符。`);
      assertBoundedString(payload.providers[key], `provider.${key}`, 1_000);
    }
  }
  if (payload.musicVolume !== undefined && (typeof payload.musicVolume !== "number" || !Number.isFinite(payload.musicVolume))) {
    throw new Error(`musicVolume 必须是 0–1 的有限数字，实际 ${String(payload.musicVolume)}。`);
  }
  if (payload.musicVolume !== undefined && (payload.musicVolume < 0 || payload.musicVolume > 1)) {
    throw new Error(`musicVolume 必须在 0–1 范围内，实际 ${payload.musicVolume}。`);
  }

  let totalDuration = 0;
  const narrations = [];
  for (const [index, shot] of payload.shots.entries()) {
    const label = `镜头 ${index + 1}`;
    assertPlainDataObject(shot, label);
    assertBoundedString(shot.id, `${label} 的 id`, 1_000);
    const hasVideo = shot.videoState === "ready" && typeof shot.videoUrl === "string" && Boolean(shot.videoUrl.trim());
    const hasImage = shot.imageState === "ready" && typeof shot.imageUrl === "string" && Boolean(shot.imageUrl.trim());
    if (!hasVideo && !hasImage) throw new Error(`${label} 缺少可用的视频或分镜图片，已阻止完整成片导出。`);
    const mediaUrl = hasVideo ? shot.videoUrl : shot.imageUrl;
    if (isDataUrl(mediaUrl)) throw new Error(`${label} 的${hasVideo ? "视频" : "图片"} data URL 不属于受控媒体，已阻止完整成片导出。`);
    assertBoundedString(mediaUrl, `${label} 的${hasVideo ? "视频" : "图片"}文件地址`, MAX_EXPORT_URL_CODE_POINTS, { required: true });
    for (const key of ["narration", "visual", "prompt", "imagePrompt", "videoPrompt", "shotType", "camera"]) {
      assertBoundedString(shot[key], `${label} 的 ${key}`, MAX_EXPORT_SHOT_TEXT_CODE_POINTS, { required: key === "narration" });
    }
    if (shot.characterIds !== undefined) {
      assertDenseArray(shot.characterIds, `${label} 的 characterIds`);
      if (shot.characterIds.length > 100) throw new Error(`${label} 的 characterIds 最多 100 项，实际 ${shot.characterIds.length}。`);
      shot.characterIds.forEach((value, characterIndex) => assertBoundedString(value, `${label} 的 characterIds[${characterIndex}]`, 1_000));
    }
    if (typeof shot.duration !== "number" || !Number.isFinite(shot.duration)) throw new Error(`${label} 的 duration 必须是有限数字，实际 ${String(shot.duration)}。`);
    if (shot.duration < MIN_EXPORT_SHOT_DURATION_SECONDS || shot.duration > MAX_EXPORT_SHOT_DURATION_SECONDS) {
      throw new Error(`${label} 时长必须为 ${MIN_EXPORT_SHOT_DURATION_SECONDS}–${MAX_EXPORT_SHOT_DURATION_SECONDS} 秒，最多 ${MAX_EXPORT_SHOT_DURATION_SECONDS} 秒，实际 ${shot.duration}。`);
    }
    totalDuration += shot.duration;
    narrations.push(shot.narration);
  }
  if (!Number.isFinite(totalDuration)) throw new Error(`完整导出总时长必须是有限数字，实际 ${String(totalDuration)}。`);
  if (totalDuration > MAX_EXPORT_TOTAL_DURATION_SECONDS + 1e-9) {
    throw new Error(`完整导出总时长最多 ${MAX_EXPORT_TOTAL_DURATION_SECONDS} 秒（6 小时），实际 ${totalDuration}。`);
  }
  const subtitleText = narrations.join("");
  if (!normalizedDocument(payload.script) || normalizedDocument(subtitleText) !== normalizedDocument(payload.script)) {
    throw new Error("字幕未完整覆盖原文文稿，已阻止完整成片导出。");
  }
  return { shotCount: payload.shots.length, totalDuration };
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function stableFileIdentity(stat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    birthtimeNs: stat.birthtimeNs,
  };
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.birthtimeNs === right.birthtimeNs;
}

async function statBigInt(filename) {
  return fs.promises.stat(filename, { bigint: true });
}

async function hashOpenFile(handle, chunkBytes = STAGING_COPY_CHUNK_BYTES, maxBytes = Number.POSITIVE_INFINITY) {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(chunkBytes);
  let position = 0;
  while (position < maxBytes) {
    const requested = Math.min(buffer.length, maxBytes - position);
    const { bytesRead } = await handle.read(buffer, 0, requested, position);
    if (!bytesRead) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return { bytes: position, sha256: hash.digest("hex") };
}

async function stageControlledMedia({ mediaDir, mediaUrl, jobDir, label, maxBytes, chunkBytes = STAGING_COPY_CHUNK_BYTES, onChunk }) {
  if (isDataUrl(mediaUrl)) throw new Error(`${label}不接受 data URL，请先保存到主进程受控媒体库。`);
  const candidate = mediaPathFromUrl(mediaDir, mediaUrl);
  if (!candidate) throw new Error(`${label}路径不属于主进程受控媒体库。`);
  let realRoot;
  let realCandidate;
  try {
    [realRoot, realCandidate] = await Promise.all([
      fs.promises.realpath(path.resolve(mediaDir)),
      fs.promises.realpath(candidate),
    ]);
  } catch { throw new Error(`${label}不可用。`); }
  if (!isWithin(realRoot, realCandidate)) throw new Error(`${label}路径不属于主进程受控媒体库。`);

  const token = crypto.randomBytes(18).toString("hex");
  const temporary = path.join(jobDir, `.${token}.partial`);
  const stagedPath = path.join(jobDir, `${crypto.randomBytes(18).toString("hex")}.media`);
  let sourceHandle;
  let targetHandle;
  try {
    sourceHandle = await fs.promises.open(realCandidate, fs.constants.O_RDONLY);
    const [descriptorBeforeStat, pathBeforeStat] = await Promise.all([sourceHandle.stat({ bigint: true }), statBigInt(candidate)]);
    if (!descriptorBeforeStat.isFile() || !pathBeforeStat.isFile() || !sameFileIdentity(stableFileIdentity(descriptorBeforeStat), stableFileIdentity(pathBeforeStat))) {
      throw new Error(`${label}在打开时已被替换。`);
    }
    if (descriptorBeforeStat.size <= 0n || descriptorBeforeStat.size > BigInt(maxBytes)) throw new Error(`${label}文件大小超过安全上限或为空。`);
    const descriptorBefore = stableFileIdentity(descriptorBeforeStat);
    targetHandle = await fs.promises.open(temporary, "wx", 0o600);
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(Number(chunkBytes) || STAGING_COPY_CHUNK_BYTES, STAGING_COPY_CHUNK_BYTES)));
    let position = 0;
    let chunkIndex = 0;
    while (true) {
      const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      if (position + bytesRead > maxBytes) throw new Error(`${label}复制期间增长并超过安全上限。`);
      const view = buffer.subarray(0, bytesRead);
      let written = 0;
      while (written < view.length) {
        const result = await targetHandle.write(view, written, view.length - written, position + written);
        if (!result.bytesWritten) throw new Error(`${label}暂存写入失败。`);
        written += result.bytesWritten;
      }
      hash.update(view);
      position += bytesRead;
      await onChunk?.({ chunkIndex, bytesCopied: position });
      chunkIndex += 1;
    }
    const [descriptorAfterStat, pathAfterStat] = await Promise.all([sourceHandle.stat({ bigint: true }), statBigInt(candidate)]);
    const descriptorAfter = stableFileIdentity(descriptorAfterStat);
    const pathAfter = stableFileIdentity(pathAfterStat);
    if (!sameFileIdentity(descriptorBefore, descriptorAfter) || !sameFileIdentity(descriptorAfter, pathAfter) || BigInt(position) !== descriptorBefore.size) {
      throw new Error(`${label}源文件在复制期间发生变化或被替换。`);
    }
    await targetHandle.sync();
    await targetHandle.close();
    targetHandle = undefined;
    await fs.promises.rename(temporary, stagedPath);
    await fs.promises.chmod(stagedPath, 0o600).catch(() => {});
    const stagedStat = await statBigInt(stagedPath);
    return {
      path: stagedPath,
      sourceName: path.basename(candidate),
      bytes: position,
      sha256: hash.digest("hex"),
      identity: stableFileIdentity(stagedStat),
    };
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`${label}不可用或在暂存期间被替换。`);
    throw error;
  } finally {
    await targetHandle?.close().catch(() => {});
    await sourceHandle?.close().catch(() => {});
    await fs.promises.rm(temporary, { force: true }).catch(() => {});
  }
}

async function verifyStagedMedia(record, label) {
  let handle;
  try {
    handle = await fs.promises.open(record.path, fs.constants.O_RDONLY);
    const before = stableFileIdentity(await handle.stat({ bigint: true }));
    const pathIdentity = stableFileIdentity(await statBigInt(record.path));
    if (!sameFileIdentity(record.identity, before) || !sameFileIdentity(before, pathIdentity)) throw new Error(`${label}暂存副本身份发生变化。`);
    const hashed = await hashOpenFile(handle);
    const after = stableFileIdentity(await handle.stat({ bigint: true }));
    const pathAfter = stableFileIdentity(await statBigInt(record.path));
    if (!sameFileIdentity(before, after) || !sameFileIdentity(after, pathAfter) || hashed.bytes !== record.bytes || hashed.sha256 !== record.sha256) {
      throw new Error(`${label}暂存副本字节发生变化。`);
    }
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`${label}暂存副本不可用。`);
    throw error;
  } finally { await handle?.close().catch(() => {}); }
}

async function createRenderJob(mediaDir) {
  const root = path.join(mediaDir, "render-jobs");
  await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
  await fs.promises.chmod(root, 0o700).catch(() => {});
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const jobDir = path.join(root, `job-${crypto.randomBytes(24).toString("hex")}`);
    try {
      await fs.promises.mkdir(jobDir, { mode: 0o700 });
      await fs.promises.chmod(jobDir, 0o700).catch(() => {});
      return jobDir;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw new Error("无法创建唯一的安全渲染任务目录。");
}

function safeMediaReference(value) {
  try {
    const url = new URL(String(value || ""));
    return `/__media/${encodeURIComponent(path.basename(decodeURIComponent(url.pathname)))}`;
  } catch { return path.basename(String(value || "")); }
}

function streamDuration(stream) {
  const direct = Number(stream?.duration);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const durationTs = Number(stream?.duration_ts);
  const [numerator, denominator] = String(stream?.time_base || "").split("/").map(Number);
  const calculated = durationTs * numerator / denominator;
  return Number.isFinite(calculated) && calculated > 0 ? calculated : 0;
}

function assertDurationMatches(actual, expected, message) {
  if (!(actual >= expected - MEDIA_DURATION_TOLERANCE_SECONDS && actual <= expected + MEDIA_DURATION_TOLERANCE_SECONDS)) {
    throw new Error(message);
  }
}

async function stageRenderInputs(payload, mediaDir, jobDir) {
  const voice = await stageControlledMedia({
    mediaDir,
    mediaUrl: payload.voiceUrl,
    jobDir,
    label: "完整配音文件",
    maxBytes: MAX_EXPORT_AUDIO_BYTES,
  });
  const shots = [];
  for (const [index, shot] of payload.shots.entries()) {
    const kind = shot.videoState === "ready" && String(shot.videoUrl || "").trim() ? "video" : "image";
    const staged = await stageControlledMedia({
      mediaDir,
      mediaUrl: kind === "video" ? shot.videoUrl : shot.imageUrl,
      jobDir,
      label: `镜头 ${index + 1} 的${kind === "video" ? "视频" : "分镜图片"}文件`,
      maxBytes: kind === "video" ? MAX_EXPORT_VIDEO_BYTES : MAX_EXPORT_IMAGE_BYTES,
    });
    shots.push({ ...staged, kind });
  }
  const music = String(payload.musicUrl || "").trim()
    ? await stageControlledMedia({ mediaDir, mediaUrl: payload.musicUrl, jobDir, label: "背景音乐文件", maxBytes: MAX_EXPORT_MUSIC_BYTES })
    : null;
  return { voice, shots, music };
}

async function preflightRender(payload, mediaDir, staged) {
  await verifyStagedMedia(staged.voice, "完整配音文件");
  const voice = await verifyVoiceProvenance({
    mediaDir,
    filename: staged.voice.sourceName,
    script: payload.script,
    mediaPath: staged.voice.path,
  });
  const totalDuration = payload.shots.reduce((sum, shot) => sum + shot.duration, 0);
  assertDurationMatches(voice.duration, totalDuration, "配音时长与成片不一致，请重新生成或调整镜头时长。");

  const shots = [];
  let timelineCursor = 0;
  for (const [index, shot] of payload.shots.entries()) {
    const requestedDuration = shot.duration;
    const stagedVisual = staged.shots[index];
    const label = `镜头 ${index + 1} 的${stagedVisual.kind === "video" ? "视频" : "分镜图片"}文件`;
    await verifyStagedMedia(stagedVisual, label);
    let sourceDuration = requestedDuration;
    if (stagedVisual.kind === "video") {
      const probe = await probeMediaFile(stagedVisual.path, "video");
      if (probe.duration < requestedDuration - MEDIA_DURATION_TOLERANCE_SECONDS) {
        throw new Error(`镜头 ${index + 1} 的视频实际时长不足，视频时长必须覆盖声明镜头时长。`);
      }
      sourceDuration = probe.duration;
    } else {
      const bytes = await fs.promises.readFile(stagedVisual.path);
      const mimeType = detectImageMime(bytes);
      if (!mimeType) throw new Error(`镜头 ${index + 1} 的分镜图片格式无效。`);
      validateImageBuffer(bytes, mimeType, { maxBytes: MAX_EXPORT_IMAGE_BYTES });
    }
    shots.push({
      shot,
      visualPath: stagedVisual.path,
      visualKind: stagedVisual.kind,
      staged: stagedVisual,
      requestedDuration,
      sourceDuration,
      finalStart: timelineCursor,
      finalEnd: timelineCursor + requestedDuration,
      inputVisualSha256: stagedVisual.sha256,
    });
    timelineCursor += requestedDuration;
  }

  let musicPath = "";
  let musicDuration = 0;
  if (staged.music) {
    await verifyStagedMedia(staged.music, "背景音乐文件");
    musicPath = staged.music.path;
    const musicProbe = await probeMediaFile(musicPath, "audio");
    musicDuration = musicProbe.duration;
  }
  return { voice, voicePath: staged.voice.path, stagedVoice: staged.voice, totalDuration, shots, musicPath, musicDuration, stagedMusic: staged.music };
}

async function verifyFinalOutput(filename, totalDuration) {
  const probe = await probeMediaFile(filename, "video");
  const video = probe.streams.find((stream) => stream.codec_type === "video");
  const audio = probe.streams.find((stream) => stream.codec_type === "audio");
  const subtitle = probe.streams.find((stream) => stream.codec_type === "subtitle");
  if (!audio || !subtitle) throw new Error("最终成片缺少音频流或字幕流，已阻止输出。");
  const containerDuration = Number(probe.format.duration);
  for (const [kind, duration] of [
    ["视频流", streamDuration(video)],
    ["音频流", streamDuration(audio)],
    ["字幕流", streamDuration(subtitle)],
    ["容器", containerDuration],
  ]) {
    assertDurationMatches(duration, totalDuration, `最终成片${kind}时长未完整覆盖时间线，已阻止输出。`);
  }
  return { containerDuration, videoDuration: streamDuration(video), audioDuration: streamDuration(audio), subtitleDuration: streamDuration(subtitle) };
}

async function fsyncDirectory(directory) {
  let handle;
  try {
    handle = await fs.promises.open(directory, fs.constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (!(["EACCES", "EPERM", "EISDIR", "EINVAL", "ENOTSUP"].includes(error?.code))) throw error;
  } finally { await handle?.close().catch(() => {}); }
}

async function existingFileState(filename, label) {
  try {
    const stat = await fs.promises.lstat(filename);
    if (stat.isDirectory()) throw new Error(`${label}目标是目录，不能发布文件。`);
    if (!stat.isFile()) throw new Error(`${label}目标不是普通文件。`);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function copyDescriptorToExclusiveTemp(record, temporary) {
  let output;
  try {
    output = await fs.promises.open(temporary, "wx", 0o600);
    const buffer = Buffer.allocUnsafe(STAGING_COPY_CHUNK_BYTES);
    const hash = crypto.createHash("sha256");
    let position = 0;
    while (true) {
      const { bytesRead } = await record.handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      if (position + bytesRead > record.expectedBytes) throw new Error("最终 MP4 实际复制字节超过已验证大小。");
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      let written = 0;
      while (written < chunk.length) {
        const result = await output.write(chunk, written, chunk.length - written, position + written);
        if (!result.bytesWritten) throw new Error("最终 MP4 临时文件写入中断。");
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    if (position !== record.expectedBytes || hash.digest("hex") !== record.expectedSha256) throw new Error("最终 MP4 复制字节与已验证 SHA-256 不一致。");
    await output.sync();
  } finally { await output?.close().catch(() => {}); }
}

async function copyFileToExclusiveRecovery(source, destination) {
  let input;
  let output;
  try {
    input = await fs.promises.open(source, fs.constants.O_RDONLY);
    output = await fs.promises.open(destination, "wx", 0o600);
    const buffer = Buffer.allocUnsafe(STAGING_COPY_CHUNK_BYTES);
    const hash = crypto.createHash("sha256");
    let size = 0;
    while (true) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, size);
      if (!bytesRead) break;
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      let written = 0;
      while (written < chunk.length) {
        const result = await output.write(chunk, written, chunk.length - written, size + written);
        if (!result.bytesWritten) throw new Error("Recovery copy write was interrupted.");
        written += result.bytesWritten;
      }
      size += bytesRead;
    }
    await output.sync();
    return { size, sha256: hash.digest("hex") };
  } finally {
    await output?.close().catch(() => {});
    await input?.close().catch(() => {});
  }
}

async function hashRegularFile(filename) {
  const handle = await fs.promises.open(filename, fs.constants.O_RDONLY);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Recovery artifact is not a regular file.");
    return await hashOpenFile(handle, STAGING_COPY_CHUNK_BYTES, stat.size);
  } finally { await handle.close().catch(() => {}); }
}

async function verifyRecoveryArtifact(filename, expected) {
  const actual = await hashRegularFile(filename);
  if (actual.bytes !== expected.size || actual.sha256 !== expected.sha256) {
    throw new Error(`Recovery verification failed for ${path.basename(filename)}.`);
  }
}

function recoveryErrorRecord(step, error) {
  return {
    step,
    code: typeof error?.code === "string" ? error.code.slice(0, 40) : "RECOVERY_FAILED",
    message: `Local recovery step failed (${typeof error?.code === "string" ? error.code.slice(0, 40) : "unknown error"}).`,
  };
}

async function writeRecoveryMetadataAtomic(filename, value) {
  const temporary = `${filename}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  let handle;
  try {
    handle = await fs.promises.open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.promises.rename(temporary, filename);
    await fsyncDirectory(path.dirname(filename));
  } finally {
    await handle?.close().catch(() => {});
    await fs.promises.rm(temporary, { force: true }).catch(() => {});
  }
}

async function restoreFromRecovery({ backup, destination, expected, temporary, beforeRestore }) {
  await verifyRecoveryArtifact(backup, expected);
  const copied = await copyFileToExclusiveRecovery(backup, temporary);
  if (copied.size !== expected.size || copied.sha256 !== expected.sha256) throw new Error("Recovery staging copy did not match the recorded artifact.");
  try {
    await beforeRestore?.();
    await fs.promises.rename(temporary, destination);
    await verifyRecoveryArtifact(destination, expected);
  } finally { await fs.promises.rm(temporary, { force: true }).catch(() => {}); }
}

function publicationError(primary, recoveryErrors, recoveryPaths = []) {
  const primaryMessage = primary instanceof Error ? primary.message : String(primary);
  const details = recoveryErrors.map(({ step, error }) => `${step}: ${error instanceof Error ? error.message : String(error)}`);
  const location = recoveryPaths.length
    ? ` Recovery copies were retained at: ${recoveryPaths.join(", ")}. Restore both artifacts from those local files before the next export.`
    : "";
  const error = new AggregateError([primary, ...recoveryErrors.map((item) => item.error)], [primaryMessage, ...details].join("; ") + location);
  if (primary?.code) error.code = primary.code;
  return error;
}

async function publishArtifactPair({ sourceOutput, sourceRecord, outputPath, manifestPath, manifest }, hooks = {}) {
  const outputDirectory = path.dirname(path.resolve(outputPath));
  const manifestDirectory = path.dirname(path.resolve(manifestPath));
  if (outputDirectory !== manifestDirectory) throw new Error("MP4 与 manifest 必须发布到同一目标目录。");
  const directoryStat = await fs.promises.stat(outputDirectory);
  if (!directoryStat.isDirectory()) throw new Error("最终输出父路径不是目录。");
  await fs.promises.access(outputDirectory, fs.constants.W_OK);
  const [hadOutput, hadManifest] = await Promise.all([
    existingFileState(outputPath, "MP4"),
    existingFileState(manifestPath, "manifest"),
  ]);
  if (hadOutput !== hadManifest) throw new Error("现有 MP4 与 manifest 不是完整配对，已拒绝覆盖。");

  const serializedManifest = `${JSON.stringify(manifest, null, 2)}\n`;
  const parsedManifest = JSON.parse(serializedManifest);
  if (!parsedManifest || typeof parsedManifest !== "object" || Array.isArray(parsedManifest)) throw new Error("manifest 内容不是完整对象。");
  const token = `${process.pid}-${crypto.randomBytes(18).toString("hex")}`;
  const outputTemp = path.join(outputDirectory, `.${path.basename(outputPath)}.${token}.tmp`);
  const manifestTemp = path.join(outputDirectory, `.${path.basename(manifestPath)}.${token}.tmp`);
  const outputBackup = path.join(outputDirectory, `.${path.basename(outputPath)}.${token}.backup`);
  const manifestBackup = path.join(outputDirectory, `.${path.basename(manifestPath)}.${token}.backup`);
  const recoveryMetadata = path.join(outputDirectory, `.storyforge-${token}.recovery.json`);
  const outputRestoreTemp = path.join(outputDirectory, `.${path.basename(outputPath)}.${token}.restore.tmp`);
  const manifestRestoreTemp = path.join(outputDirectory, `.${path.basename(manifestPath)}.${token}.restore.tmp`);
  let openedSource;
  let manifestHandle;
  let recoveryRecords;
  let recoveryPreparationStarted = false;
  let outputCommitted = false;
  let manifestCommitted = false;
  try {
    try {
    const record = sourceRecord || await openGeneratedMedia(sourceOutput, "最终 MP4", "output");
    if (!sourceRecord) openedSource = record;
    await copyDescriptorToExclusiveTemp(record, outputTemp);
    manifestHandle = await fs.promises.open(manifestTemp, "wx", 0o600);
    await manifestHandle.writeFile(serializedManifest, "utf8");
    await manifestHandle.sync();
    await manifestHandle.close();
    manifestHandle = undefined;

    if (hadOutput) {
      recoveryPreparationStarted = true;
      const output = await copyFileToExclusiveRecovery(outputPath, outputBackup);
      const manifestRecord = await copyFileToExclusiveRecovery(manifestPath, manifestBackup);
      await verifyRecoveryArtifact(outputBackup, output);
      await verifyRecoveryArtifact(manifestBackup, manifestRecord);
      recoveryRecords = { output, manifest: manifestRecord };
      await writeRecoveryMetadataAtomic(recoveryMetadata, {
        version: 1,
        state: "recovery-ready",
        artifacts: {
          output: { backupBasename: path.basename(outputBackup), ...output },
          manifest: { backupBasename: path.basename(manifestBackup), ...manifestRecord },
        },
        errors: [],
      });
      await fsyncDirectory(outputDirectory);
    }
    await hooks.beforeOutputCommit?.();
    await fs.promises.rename(outputTemp, outputPath);
    outputCommitted = true;
    await hooks.afterOutputCommit?.();
    await hooks.beforeManifestCommit?.();
    await fs.promises.rename(manifestTemp, manifestPath);
    manifestCommitted = true;
    await hooks.afterManifestCommit?.();
    await fsyncDirectory(outputDirectory);
  } catch (error) {
    const rollbackErrors = [];
    let oldPairRestored = false;
    if (recoveryRecords) {
      let restoredArtifacts = 0;
      for (const artifact of [
        { kind: "output", destination: outputPath, backup: outputBackup, expected: recoveryRecords.output, temporary: outputRestoreTemp, hook: hooks.beforeOutputRecoveryRestore },
        { kind: "manifest", destination: manifestPath, backup: manifestBackup, expected: recoveryRecords.manifest, temporary: manifestRestoreTemp, hook: hooks.beforeManifestRecoveryRestore },
      ]) {
        try {
          let current = null;
          try { current = await hashRegularFile(artifact.destination); }
          catch (verificationError) {
            if (verificationError?.code !== "ENOENT") rollbackErrors.push({ step: `${artifact.kind} pre-restore verification`, error: verificationError });
          }
          if (!current || current.bytes !== artifact.expected.size || current.sha256 !== artifact.expected.sha256) {
            await restoreFromRecovery({ backup: artifact.backup, destination: artifact.destination, expected: artifact.expected, temporary: artifact.temporary, beforeRestore: artifact.hook });
          }
          await verifyRecoveryArtifact(artifact.destination, artifact.expected);
          restoredArtifacts += 1;
        } catch (restoreError) { rollbackErrors.push({ step: `${artifact.kind} restore`, error: restoreError }); }
      }
      oldPairRestored = restoredArtifacts === 2;
    } else {
      for (const [kind, committed, filename] of [["manifest", manifestCommitted, manifestPath], ["output", outputCommitted, outputPath]]) {
        if (!committed) continue;
        try { await fs.promises.rm(filename, { force: true }); }
        catch (removeError) { rollbackErrors.push({ step: `${kind} rollback removal`, error: removeError }); }
      }
      if (recoveryPreparationStarted && !outputCommitted && !manifestCommitted) {
        for (const [kind, filename] of [["output", outputBackup], ["manifest", manifestBackup], ["metadata", recoveryMetadata]]) {
          try { await fs.promises.rm(filename, { force: true }); }
          catch (cleanupError) { rollbackErrors.push({ step: `${kind} incomplete recovery preparation cleanup`, error: cleanupError }); }
        }
      }
    }
    try { await fsyncDirectory(outputDirectory); }
    catch (syncError) { rollbackErrors.push({ step: "rollback directory fsync", error: syncError }); }

    if (recoveryRecords && oldPairRestored) {
      for (const [kind, filename] of [["output", outputBackup], ["manifest", manifestBackup]]) {
        try { await hooks.beforeBackupCleanup?.(kind); await fs.promises.rm(filename); }
        catch (cleanupError) { rollbackErrors.push({ step: `${kind} recovery cleanup`, error: cleanupError }); }
      }
      if (!rollbackErrors.some((item) => item.step.includes("cleanup"))) {
        try { await hooks.beforeBackupCleanup?.("metadata"); await fs.promises.rm(recoveryMetadata); }
        catch (cleanupError) { rollbackErrors.push({ step: "recovery metadata cleanup", error: cleanupError }); }
      }
    }
    const recoveryStateRetained = [outputBackup, manifestBackup, recoveryMetadata].some((filename) => fs.existsSync(filename));
    if (recoveryRecords && (!oldPairRestored || recoveryStateRetained)) {
      try {
        await writeRecoveryMetadataAtomic(recoveryMetadata, {
          version: 1,
          state: oldPairRestored ? "old-restored-cleanup-incomplete" : "rollback-incomplete",
          artifacts: {
            output: { backupBasename: path.basename(outputBackup), ...recoveryRecords.output },
            manifest: { backupBasename: path.basename(manifestBackup), ...recoveryRecords.manifest },
          },
          errors: rollbackErrors.map((item) => recoveryErrorRecord(item.step, item.error)),
        });
      } catch (metadataError) { rollbackErrors.push({ step: "recovery metadata write", error: metadataError }); }
    }
    const retainedRecovery = [outputBackup, manifestBackup].filter((filename) => fs.existsSync(filename));
    throw publicationError(error, rollbackErrors, retainedRecovery);
  }

    if (recoveryRecords) {
    const cleanupErrors = [];
    for (const [kind, filename] of [["output", outputBackup], ["manifest", manifestBackup]]) {
      try { await hooks.beforeBackupCleanup?.(kind); await fs.promises.rm(filename); }
      catch (cleanupError) { cleanupErrors.push({ step: `${kind} recovery cleanup`, error: cleanupError }); }
    }
    if (!cleanupErrors.length) {
      try { await hooks.beforeBackupCleanup?.("metadata"); await fs.promises.rm(recoveryMetadata); }
      catch (cleanupError) { cleanupErrors.push({ step: "recovery metadata cleanup", error: cleanupError }); }
    }
    if (cleanupErrors.length) {
      try {
        await writeRecoveryMetadataAtomic(recoveryMetadata, {
          version: 1,
          state: "new-durable-cleanup-incomplete",
          artifacts: {
            output: { backupBasename: path.basename(outputBackup), ...recoveryRecords.output },
            manifest: { backupBasename: path.basename(manifestBackup), ...recoveryRecords.manifest },
          },
          errors: cleanupErrors.map((item) => recoveryErrorRecord(item.step, item.error)),
        });
      } catch (metadataError) { cleanupErrors.push({ step: "recovery metadata write", error: metadataError }); }
      const retainedRecovery = [outputBackup, manifestBackup].filter((filename) => fs.existsSync(filename));
      throw publicationError(new Error("The new artifact pair is durable, but recovery cleanup failed."), cleanupErrors, retainedRecovery);
    }
    }
  } finally {
    await manifestHandle?.close().catch(() => {});
    await openedSource?.handle.close().catch(() => {});
    await Promise.all([
      fs.promises.rm(outputTemp, { force: true }),
      fs.promises.rm(manifestTemp, { force: true }),
      fs.promises.rm(outputRestoreTemp, { force: true }),
      fs.promises.rm(manifestRestoreTemp, { force: true }),
    ].map((operation) => operation.catch(() => {})));
  }
}

async function renderVideo(payload, mediaDir, outputPath, testHooks = {}) {
  validateCompleteRenderPayload(payload);
  const jobDir = await createRenderJob(mediaDir);
  const temporaryOutput = path.join(jobDir, `rendered-${crypto.randomBytes(8).toString("hex")}.mp4`);
  const manifestPath = outputPath.replace(/\.mp4$/i, "") + ".render-manifest.json";
  const portrait = payload.ratio === "9:16";
  const width = portrait ? 1080 : 1920;
  const height = portrait ? 1920 : 1080;
  const clips = [];
  try {
    const staged = await stageRenderInputs(payload, mediaDir, jobDir);
    await testHooks.onAfterStaging?.(staged);
    const preflight = await preflightRender(payload, mediaDir, staged);
    for (const [index, item] of preflight.shots.entries()) {
      const sourceLabel = `镜头 ${index + 1} 的${item.visualKind === "video" ? "视频" : "分镜图片"}文件`;
      const source = await openVerifiedMedia(item.staged, sourceLabel, `shot-${index + 1}`);
      const clip = path.join(jobDir, `clip-${String(index).padStart(3, "0")}.ts`);
      let filter;
      let durationArgs;
      if (item.visualKind === "image") {
        const frames = Math.max(1, Math.ceil(item.requestedDuration * 30));
        const zoomStep = (0.03 / Math.max(1, frames - 1)).toFixed(10);
        filter = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},zoompan=z='min(zoom+${zoomStep},1.03)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${width}x${height}:fps=30,format=yuv420p`;
        durationArgs = ["-frames:v", String(frames)];
      } else {
        const stretch = item.sourceDuration < item.requestedDuration
          ? (item.requestedDuration / item.sourceDuration).toFixed(8)
          : "1";
        filter = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,fps=30,setpts=(PTS-STARTPTS)*${stretch}`;
        durationArgs = ["-t", String(item.requestedDuration)];
      }
      await runFfmpegFromHandles(["-y", "-i", "pipe:3", ...durationArgs, "-vf", filter, "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p", "-muxdelay", "0", "-f", "mpegts", clip], [source], {
        phase: `shot-${index + 1}`,
        beforeSpawn: testHooks.onBeforeFfmpegSpawn,
      });
      clips.push(await openGeneratedMedia(clip, `镜头 ${index + 1} 内部 segment`, `segment-${index + 1}`));
    }

    const subtitles = path.join(jobDir, "subtitles.srt");
    await fs.promises.writeFile(subtitles, payload.shots.map((shot, index) => `${index + 1}\n${srtTime(preflight.shots[index].finalStart)} --> ${srtTime(preflight.shots[index].finalEnd)}\n${String(shot.narration || "").replace(/\r?\n/g, " ")}\n`).join("\n"), "utf8");
    let musicInput = null;
    if (preflight.stagedMusic) {
      const stagedMusicInput = await openVerifiedMedia(preflight.stagedMusic, "背景音乐文件", "music");
      const normalizedMusic = path.join(jobDir, "music.pcm");
      await runFfmpegFromHandles(["-y", "-i", "pipe:3", "-vn", "-f", "s16le", "-ar", "48000", "-ac", "2", normalizedMusic], [stagedMusicInput], {
        phase: "music-normalize",
        beforeSpawn: testHooks.onBeforeFfmpegSpawn,
      });
      musicInput = await openGeneratedMedia(normalizedMusic, "内部背景音乐 PCM", "music");
      musicInput.totalStreamBytes = Math.ceil(preflight.totalDuration * 48_000) * 4;
      const prefixBytes = musicInput.totalStreamBytes % musicInput.expectedBytes;
      if (prefixBytes) musicInput.expectedPrefixSha256 = (await hashOpenFile(musicInput.handle, STAGING_COPY_CHUNK_BYTES, prefixBytes)).sha256;
    }
    const subtitleInput = await openGeneratedMedia(subtitles, "内部字幕", "subtitles");
    const voiceInput = await openVerifiedMedia(preflight.stagedVoice, "完整配音文件", "voice");
    const args = ["-y", "-f", "mpegts", "-i", "pipe:3", "-i", "pipe:4"];
    const ffmpegInputs = [{ role: "segments", records: clips }, voiceInput];
    let subtitleIndex = 2;
    if (musicInput) {
      args.push("-f", "s16le", "-ar", "48000", "-ac", "2", "-i", "pipe:5");
      ffmpegInputs.push(musicInput);
      subtitleIndex = 3;
    }
    const subtitlePipe = 3 + ffmpegInputs.length;
    args.push("-f", "srt", "-i", `pipe:${subtitlePipe}`, "-map", "0:v:0");
    ffmpegInputs.push(subtitleInput);
    if (musicInput) {
      const musicVolume = payload.musicVolume ?? 0.22;
      const fadeStart = Math.max(0, preflight.totalDuration - 1.5);
      args.push("-filter_complex", `[1:a]aresample=async=1:first_pts=0[voice];[2:a]volume=${musicVolume.toFixed(3)},afade=t=out:st=${fadeStart.toFixed(3)}:d=1.5[music];[voice][music]amix=inputs=2:duration=longest:dropout_transition=2:normalize=0,alimiter=limit=0.95[aout]`, "-map", "[aout]");
    } else {
      args.push("-filter_complex", "[1:a]aresample=async=1:first_pts=0[aout]", "-map", "[aout]");
    }
    args.push("-map", `${subtitleIndex}:s:0`, "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-c:s", "mov_text", "-metadata:s:s:0", "language=zho", "-t", String(preflight.totalDuration), temporaryOutput);
    await runFfmpegFromHandles(args, ffmpegInputs, { phase: "final-mux", beforeSpawn: testHooks.onBeforeFfmpegSpawn });
    const finalDurations = await verifyFinalOutput(temporaryOutput, preflight.totalDuration);

    const manifest = {
      version: 2,
      kind: "complete-movie",
      outputFile: path.basename(outputPath),
      totalDuration: preflight.totalDuration,
      toleranceSeconds: MEDIA_DURATION_TOLERANCE_SECONDS,
      voice: {
        mediaId: preflight.voice.entry.mediaId,
        mediaUrl: safeMediaReference(payload.voiceUrl),
        scriptSha256: preflight.voice.entry.scriptSha256,
        inputAudioSha256: preflight.stagedVoice.sha256,
        sourceDuration: preflight.voice.duration,
        generationSource: preflight.voice.entry.source,
      },
      ...(preflight.stagedMusic ? {
        music: {
          mediaUrl: safeMediaReference(payload.musicUrl),
          inputAudioSha256: preflight.stagedMusic.sha256,
          sourceDuration: preflight.musicDuration,
          volume: payload.musicVolume ?? 0.22,
        },
      } : {}),
      finalDurations,
      shots: preflight.shots.map((item) => ({
        shotId: String(item.shot.id || ""),
        visualKind: item.visualKind,
        mediaUrl: safeMediaReference(item.visualKind === "video" ? item.shot.videoUrl : item.shot.imageUrl),
        inputVisualSha256: item.inputVisualSha256,
        ...(item.visualKind === "video" ? { videoUrl: safeMediaReference(item.shot.videoUrl), inputVideoSha256: item.inputVisualSha256 } : { imageUrl: safeMediaReference(item.shot.imageUrl), inputImageSha256: item.inputVisualSha256 }),
        staticImageZoom: item.visualKind === "image" ? { from: 1, to: 1.03 } : null,
        requestedDuration: item.requestedDuration,
        sourceDuration: item.sourceDuration,
        duration: item.requestedDuration,
        finalStart: item.finalStart,
        finalEnd: item.finalEnd,
      })),
    };
    const finalOutputRecord = await openGeneratedMedia(temporaryOutput, "最终 MP4", "output");
    try {
      await publishArtifactPair({ sourceRecord: finalOutputRecord, outputPath, manifestPath, manifest }, testHooks.publishHooks);
    } finally { await finalOutputRecord.handle.close().catch(() => {}); }
    return { ok: true, outputPath, manifestPath };
  } catch (error) {
    await fs.promises.rm(temporaryOutput, { force: true }).catch(() => {});
    throw error;
  } finally {
    await Promise.allSettled(clips.map((clip) => clip.handle?.close()));
    const resolved = path.resolve(jobDir);
    const root = path.resolve(mediaDir, "render-jobs") + path.sep;
    if (resolved.startsWith(root)) await fs.promises.rm(resolved, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  MAX_EXPORT_AUDIO_BYTES,
  MAX_EXPORT_SCRIPT_CODE_POINTS,
  MAX_EXPORT_SHOTS,
  MAX_EXPORT_SHOT_DURATION_SECONDS,
  MAX_EXPORT_TOTAL_DURATION_SECONDS,
  MAX_EXPORT_VIDEO_BYTES,
  MEDIA_DURATION_TOLERANCE_SECONDS,
  renderVideo,
  validateCompleteRenderPayload,
  _test: { createRenderJob, openGeneratedMedia, openVerifiedMedia, publishArtifactPair, runFfmpegFromHandles, stageControlledMedia, verifyStagedMedia },
};
