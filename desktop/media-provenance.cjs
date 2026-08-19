const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { probeMediaFile, sha256File } = require("./media-tools.cjs");

const INDEX_FILENAME = "media-provenance.json";
const MAX_INDEX_BYTES = 4 * 1024 * 1024;
const MAX_VOICE_BYTES = 64 * 1024 * 1024;

function normalizeScript(value) {
  return String(value || "").normalize("NFKC").replace(/\r\n?/g, "\n").trim();
}

function scriptSha256(script) {
  return crypto.createHash("sha256").update(normalizeScript(script), "utf8").digest("hex");
}

function indexPath(mediaDir) {
  return path.join(mediaDir, INDEX_FILENAME);
}

async function readIndex(mediaDir) {
  const filename = indexPath(mediaDir);
  try {
    const stat = await fs.promises.stat(filename);
    if (!stat.isFile() || stat.size > MAX_INDEX_BYTES) throw new Error("配音可信记录不可用");
    const parsed = JSON.parse(await fs.promises.readFile(filename, "utf8"));
    if (parsed?.version !== 1 || !parsed.voice || typeof parsed.voice !== "object") throw new Error("配音可信记录不可用");
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") return { version: 1, voice: {} };
    throw error;
  }
}

async function writeIndexAtomic(mediaDir, index) {
  await fs.promises.mkdir(mediaDir, { recursive: true });
  const destination = indexPath(mediaDir);
  const temporary = path.join(mediaDir, `.${INDEX_FILENAME}.${process.pid}-${crypto.randomBytes(6).toString("hex")}.tmp`);
  try {
    await fs.promises.writeFile(temporary, `${JSON.stringify(index, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await fs.promises.rename(temporary, destination);
  } finally {
    await fs.promises.rm(temporary, { force: true }).catch(() => {});
  }
}

function trustedVoicePath(mediaDir, filename) {
  const name = path.basename(String(filename || ""));
  if (!name || name !== filename || /[\\/\0]/.test(name)) throw new Error("配音受控媒体路径无效");
  const root = path.resolve(mediaDir);
  const candidate = path.resolve(root, name);
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("配音受控媒体路径无效");
  return candidate;
}

async function persistVoiceProvenance({ mediaDir, filename, script, source }) {
  const voicePath = trustedVoicePath(mediaDir, filename);
  const stat = await fs.promises.stat(voicePath);
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_VOICE_BYTES) throw new Error("生成的配音文件大小不可用");
  const probe = await probeMediaFile(voicePath, "audio");
  const entry = {
    mediaId: crypto.randomUUID(),
    relativePath: path.basename(voicePath),
    kind: "voice",
    scriptSha256: scriptSha256(script),
    fileSha256: await sha256File(voicePath),
    duration: probe.duration,
    source: String(source || "main-process-speech"),
    createdAt: new Date().toISOString(),
  };
  const index = await readIndex(mediaDir);
  index.voice[entry.relativePath] = entry;
  await writeIndexAtomic(mediaDir, index);
  return entry;
}

async function verifyVoiceProvenance({ mediaDir, filename, script, mediaPath }) {
  const trustedPath = trustedVoicePath(mediaDir, filename);
  const voicePath = mediaPath ? path.resolve(mediaPath) : trustedPath;
  const index = await readIndex(mediaDir);
  const entry = index.voice[path.basename(filename)];
  if (!entry) throw new Error("旧项目缺少可信配音记录，请重新生成配音。");
  if (entry.relativePath !== path.basename(filename) || entry.kind !== "voice") throw new Error("配音可信记录与媒体不一致，请重新生成配音。");
  if (entry.scriptSha256 !== scriptSha256(script)) throw new Error("配音未绑定当前文稿，请重新生成配音。");
  let stat;
  try { stat = await fs.promises.stat(voicePath); }
  catch { throw new Error("完整配音文件不可用，请重新生成配音。"); }
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_VOICE_BYTES) throw new Error("完整配音文件不可用，请重新生成配音。");
  if (await sha256File(voicePath) !== entry.fileSha256) throw new Error("配音文件字节已变化或被替换，请重新生成配音。");
  const probe = await probeMediaFile(voicePath, "audio");
  if (Math.abs(probe.duration - Number(entry.duration)) > 0.05) throw new Error("配音文件实际时长与可信记录不一致，请重新生成配音。");
  return { entry, path: voicePath, duration: probe.duration, probe };
}

module.exports = {
  INDEX_FILENAME,
  MAX_VOICE_BYTES,
  normalizeScript,
  persistVoiceProvenance,
  scriptSha256,
  verifyVoiceProvenance,
};
