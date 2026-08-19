const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { imageDimensionsFromBuffer, validateImageBuffer } = require("./media-tools.cjs");

const MAX_PAID_VIDEO_FIRST_FRAME_BYTES = 12 * 1024 * 1024;
const FIRST_FRAME_SIZE_LIMIT_MESSAGE = "首帧图片不能超过12 MiB";
const ALLOWED_IMAGE_MIME_TYPES = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
]);
const BASE64_PAYLOAD_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

function blockedError(message) {
  return new Error(`${message}；${FIRST_FRAME_SIZE_LIMIT_MESSAGE}，已在任何付费 POST/GET 前阻止提交。`);
}

function tooLargeError() {
  return new Error(`${FIRST_FRAME_SIZE_LIMIT_MESSAGE}，已在任何付费 POST/GET 前阻止提交。`);
}

function digest(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function hasCanonicalPaddingBits(encoded, paddingLength) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  if (paddingLength === 2) return alphabet.indexOf(encoded.at(-3)) % 16 === 0;
  if (paddingLength === 1) return alphabet.indexOf(encoded.at(-2)) % 4 === 0;
  return true;
}

function decodeStrictDataUrl(mediaUrl, options = {}) {
  const value = String(mediaUrl || "");
  const commaIndex = value.indexOf(",");
  if (!value.startsWith("data:") || commaIndex < 0) throw blockedError("首帧 data URL 非法");

  const metadata = value.slice("data:".length, commaIndex);
  const metadataMatch = metadata.match(/^([^;,]+);base64$/i);
  if (!metadataMatch) throw blockedError("首帧 data URL 非法");
  const mimeType = metadataMatch[1].toLowerCase();
  const extension = ALLOWED_IMAGE_MIME_TYPES.get(mimeType);
  if (!extension) throw blockedError("首帧 data URL 不是允许的 PNG、JPEG 或 WebP 图片 MIME");

  const encodedStart = commaIndex + 1;
  const encodedLength = value.length - encodedStart;
  if (!encodedLength || encodedLength % 4 !== 0) throw blockedError("首帧 data URL 的 base64 非法");

  const conservativeDecodedBytes = (encodedLength / 4) * 3;
  if (conservativeDecodedBytes > MAX_PAID_VIDEO_FIRST_FRAME_BYTES) throw tooLargeError();

  const encoded = value.slice(encodedStart);
  if (!BASE64_PAYLOAD_PATTERN.test(encoded)) throw blockedError("首帧 data URL 的 base64 非法");
  const paddingLength = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  if (!hasCanonicalPaddingBits(encoded, paddingLength)) throw blockedError("首帧 data URL 的 base64 非法");

  const expectedBytes = conservativeDecodedBytes - paddingLength;
  if (expectedBytes > MAX_PAID_VIDEO_FIRST_FRAME_BYTES) throw tooLargeError();
  const decodeBase64 = options.decodeBase64 || ((payload) => Buffer.from(payload, "base64"));
  const buffer = decodeBase64(encoded);
  if (!Buffer.isBuffer(buffer) || buffer.length !== expectedBytes) throw blockedError("首帧 data URL 的 base64 非法");
  if (buffer.length > MAX_PAID_VIDEO_FIRST_FRAME_BYTES) throw tooLargeError();
  return { buffer, mimeType, name: `first-frame.${extension}`, sourceType: "data" };
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function localMediaPath(mediaDir, mediaUrl, io = fs) {
  let url;
  try { url = new URL(String(mediaUrl || "")); }
  catch { throw blockedError("首帧素材 URL 无效"); }
  if (!["http:", "https:"].includes(url.protocol) || !url.pathname.startsWith("/__media/")) {
    throw blockedError("首帧路径不在允许的 media 目录");
  }
  let decoded;
  try { decoded = decodeURIComponent(url.pathname.slice("/__media/".length)); }
  catch { throw blockedError("首帧素材路径编码无效"); }
  if (!decoded || decoded !== path.basename(decoded) || /[\\/\0]/.test(decoded)) {
    throw blockedError("首帧路径不在允许的 media 目录");
  }
  const root = path.resolve(mediaDir);
  const candidate = path.resolve(root, decoded);
  if (!isWithin(root, candidate) || !io.existsSync(candidate)) throw blockedError("首帧素材不存在或路径不在允许的 media 目录");
  let realRoot;
  let realCandidate;
  try {
    realRoot = io.realpathSync(root);
    realCandidate = io.realpathSync(candidate);
  } catch (error) {
    throw blockedError(`首帧素材不可读取：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isWithin(realRoot, realCandidate)) throw blockedError("首帧路径越过允许的 media 目录");
  return realCandidate;
}

function mimeForName(name) {
  const extension = path.extname(name).toLowerCase();
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  if (extension === ".png") return "image/png";
  throw blockedError("首帧素材类型不受支持");
}

function sameFileSnapshot(before, after) {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs;
}

function readLocalFileOnce(mediaDir, filePath, io = fs) {
  let descriptor;
  try {
    descriptor = io.openSync(filePath, "r");
    const before = io.fstatSync(descriptor);
    if (!before.isFile()) throw blockedError("首帧素材不是普通文件");
    const reopenedRoot = io.realpathSync(path.resolve(mediaDir));
    const reopenedPath = io.realpathSync(filePath);
    const reopenedStat = io.statSync(filePath);
    if (!isWithin(reopenedRoot, reopenedPath)
      || before.dev !== reopenedStat.dev
      || before.ino !== reopenedStat.ino) {
      throw blockedError("首帧路径或文件在打开期间发生变化");
    }
    if (before.size > MAX_PAID_VIDEO_FIRST_FRAME_BYTES) throw tooLargeError();

    const capacity = Math.min(before.size + 1, MAX_PAID_VIDEO_FIRST_FRAME_BYTES + 1);
    const allocated = Buffer.allocUnsafe(capacity);
    let bytesRead = 0;
    while (bytesRead < capacity) {
      const count = io.readSync(descriptor, allocated, bytesRead, capacity - bytesRead, bytesRead);
      if (count === 0) break;
      bytesRead += count;
    }

    const after = io.fstatSync(descriptor);
    if (bytesRead > MAX_PAID_VIDEO_FIRST_FRAME_BYTES || after.size > MAX_PAID_VIDEO_FIRST_FRAME_BYTES) throw tooLargeError();
    if (bytesRead !== before.size || !sameFileSnapshot(before, after)) {
      throw blockedError("首帧素材在读取期间发生变化");
    }
    return allocated.subarray(0, bytesRead);
  } catch (error) {
    if (error instanceof Error && error.message.includes("已在任何付费 POST/GET 前阻止提交")) throw error;
    throw blockedError(`首帧素材不可读取：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (descriptor !== undefined) {
      try { io.closeSync(descriptor); }
      catch { /* The original read/validation result takes precedence. */ }
    }
  }
}

function readPaidVideoFirstFrame(mediaDir, mediaUrl, options = {}) {
  const io = options.fs || fs;
  let input;
  if (String(mediaUrl || "").startsWith("data:")) input = decodeStrictDataUrl(mediaUrl, options);
  else {
    if (!String(mediaUrl || "").trim()) throw blockedError("缺少首帧素材");
    const filePath = localMediaPath(mediaDir, mediaUrl, io);
    const mimeType = mimeForName(filePath);
    const buffer = readLocalFileOnce(mediaDir, filePath, io);
    input = { buffer, mimeType, name: path.basename(filePath), sourceType: "media" };
  }
  const validate = options.validateImageBuffer || validateImageBuffer;
  const confirmed = validate(input.buffer, input.mimeType, { decodeImage: options.decodeImage, maxBytes: MAX_PAID_VIDEO_FIRST_FRAME_BYTES });
  const dimensions = options.includeDimensions ? (options.imageDimensions || imageDimensionsFromBuffer)(input.buffer) : {};
  return {
    ...input,
    mimeType: confirmed.mimeType,
    name: input.sourceType === "data" ? `first-frame.${confirmed.extension}` : input.name,
    digest: digest(input.buffer),
    ...dimensions,
  };
}

module.exports = {
  FIRST_FRAME_SIZE_LIMIT_MESSAGE,
  MAX_PAID_VIDEO_FIRST_FRAME_BYTES,
  readPaidVideoFirstFrame,
};
