const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

function bundledMediaExecutable(name, options = {}) {
  const platform = options.platform || process.platform;
  const resourcesPath = options.resourcesPath ?? process.resourcesPath ?? "";
  const extension = platform === "win32" ? ".exe" : "";
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  return pathApi.join(resourcesPath, `${name}${extension}`);
}

function ffmpegPath() {
  const bundled = bundledMediaExecutable("ffmpeg");
  if (fs.existsSync(bundled)) return bundled;
  try {
    const candidate = require("ffmpeg-static");
    if (candidate && fs.existsSync(candidate)) return candidate;
  } catch { /* Fall through to PATH for development. */ }
  return "ffmpeg";
}

function ffprobePath() {
  const bundled = bundledMediaExecutable("ffprobe");
  if (fs.existsSync(bundled)) return bundled;
  try {
    const candidate = require("ffprobe-static")?.path;
    if (candidate && fs.existsSync(candidate)) return candidate;
  } catch { /* Fall through to PATH for development. */ }
  return "ffprobe";
}

function actualImageMime(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return "";
}

function detectImageMime(buffer) {
  return Buffer.isBuffer(buffer) ? actualImageMime(buffer) : "";
}

function decodeImageWithFfmpeg(buffer) {
  const result = spawnSync(ffmpegPath(), [
    "-v", "error", "-i", "pipe:0", "-map", "0:v:0", "-frames:v", "1", "-f", "null",
    process.platform === "win32" ? "NUL" : "/dev/null",
  ], { input: buffer, windowsHide: true, encoding: "utf8", maxBuffer: 1024 * 1024 });
  return { ok: result.status === 0, error: String(result.stderr || "").slice(-1000) };
}

function validateImageBuffer(buffer, declaredMime, options = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error("图片字节为空或不可用");
  if (buffer.length > (options.maxBytes || MAX_IMAGE_BYTES)) throw new Error("图片素材不能超过12 MiB");
  const mimeType = String(declaredMime || "").toLowerCase();
  const detectedMime = actualImageMime(buffer);
  if (!detectedMime) throw new Error("图片真实格式无法识别或文件已损坏");
  if (detectedMime !== mimeType) throw new Error(`图片声明 MIME 与真实格式不匹配（声明 ${mimeType || "空"}，实际 ${detectedMime}）`);
  const decoder = options.decodeImage || decodeImageWithFfmpeg;
  const decoded = decoder(buffer, detectedMime);
  const ok = decoded === true || decoded?.ok === true;
  if (!ok) throw new Error(`图片无法通过真实解码，文件可能损坏或被截断${decoded?.error ? `：${decoded.error}` : ""}`);
  const extension = detectedMime === "image/jpeg" ? "jpg" : detectedMime.slice("image/".length);
  return { mimeType: detectedMime, extension };
}

function imageDimensionsFromBuffer(buffer) {
  const result = spawnSync(ffprobePath(), [
    "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", "pipe:0",
  ], { input: buffer, windowsHide: true, encoding: "utf8", maxBuffer: 1024 * 1024 });
  if (result.status !== 0) throw new Error(`图片尺寸验证失败：${String(result.stderr || "无法读取宽高").slice(-800)}`);
  let parsed;
  try { parsed = JSON.parse(String(result.stdout || "")); }
  catch { throw new Error("图片尺寸验证失败：探测结果无法解析"); }
  const width = Number(parsed?.streams?.[0]?.width);
  const height = Number(parsed?.streams?.[0]?.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new Error("图片尺寸验证失败：缺少有效宽高");
  return { width, height };
}

function runProcess(executable, args, errorPrefix) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-4 * 1024 * 1024); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-8000); });
    child.on("error", () => reject(new Error(`${errorPrefix}：无法启动媒体探测器`)));
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(`${errorPrefix}：${stderr.slice(-1200) || `退出码 ${code}`}`)));
  });
}

function durationFromStream(stream) {
  const direct = Number(stream?.duration);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const durationTs = Number(stream?.duration_ts);
  const [numerator, denominator] = String(stream?.time_base || "").split("/").map(Number);
  const calculated = durationTs * numerator / denominator;
  return Number.isFinite(calculated) && calculated > 0 ? calculated : 0;
}

function durationFromProbe(stream, format) {
  const streamDuration = durationFromStream(stream);
  if (streamDuration > 0) return streamDuration;
  const formatDuration = Number(format?.duration);
  return Number.isFinite(formatDuration) && formatDuration > 0 ? formatDuration : 0;
}

async function probeMediaFile(filename, requiredType) {
  const stdout = await runProcess(ffprobePath(), [
    "-v", "error", "-show_streams", "-show_format", "-of", "json", filename,
  ], "媒体文件验证失败");
  let parsed;
  try { parsed = JSON.parse(stdout); }
  catch { throw new Error("媒体文件验证失败：探测结果无法解析"); }
  const stream = (parsed.streams || []).find((candidate) => candidate.codec_type === requiredType);
  if (!stream) throw new Error(`媒体文件验证失败：缺少${requiredType === "audio" ? "音频" : requiredType === "video" ? "视频" : "字幕"}流`);
  // Matroska/WebM commonly stores duration at the container level instead of
  // stream.duration. ComfyUI's native SaveWEBM output is one such valid file.
  const duration = durationFromProbe(stream, parsed.format);
  if (!(duration > 0)) throw new Error("媒体文件验证失败：无法确认实际流时长");
  return { duration, stream, format: parsed.format || {}, streams: parsed.streams || [] };
}

function sha256File(filename) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const input = fs.createReadStream(filename);
    input.on("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolve(hash.digest("hex")));
  });
}

module.exports = {
  MAX_IMAGE_BYTES,
  bundledMediaExecutable,
  detectImageMime,
  durationFromProbe,
  ffmpegPath,
  ffprobePath,
  imageDimensionsFromBuffer,
  probeMediaFile,
  sha256File,
  validateImageBuffer,
};
