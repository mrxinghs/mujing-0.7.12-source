const { MAX_PAID_VIDEO_FIRST_FRAME_BYTES } = require("./media-input.cjs");
const { validateImageBuffer } = require("./media-tools.cjs");

const MAX_MEDIA_IMAGE_BYTES = MAX_PAID_VIDEO_FIRST_FRAME_BYTES;
const MIME_EXTENSIONS = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
]);
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

function invalid(message) {
  return new Error(message);
}

function hasCanonicalPaddingBits(encoded, paddingLength) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  if (paddingLength === 2) return alphabet.indexOf(encoded.at(-3)) % 16 === 0;
  if (paddingLength === 1) return alphabet.indexOf(encoded.at(-2)) % 4 === 0;
  return true;
}

function decodeImageDataUrl(dataUrl, options = {}) {
  const value = String(dataUrl || "");
  const commaIndex = value.indexOf(",");
  if (!value.startsWith("data:") || commaIndex < 0) throw invalid("图片素材 data URL 格式不正确");
  const metadata = value.slice(5, commaIndex);
  const match = metadata.match(/^([^;,]+);base64$/i);
  if (!match) throw invalid("图片素材 data URL 必须使用严格 base64 编码");
  const mimeType = match[1].toLowerCase();
  const extension = MIME_EXTENSIONS.get(mimeType);
  if (!extension) throw invalid("图片素材 MIME 仅允许 PNG、JPEG 或 WebP");

  const encodedLength = value.length - commaIndex - 1;
  if (!encodedLength || encodedLength % 4 !== 0) throw invalid("图片素材 base64 编码畸形");
  const conservativeDecodedBytes = (encodedLength / 4) * 3;
  if (conservativeDecodedBytes > MAX_MEDIA_IMAGE_BYTES) throw invalid("图片素材不能超过12 MiB");

  const encoded = value.slice(commaIndex + 1);
  if (!BASE64_PATTERN.test(encoded)) throw invalid("图片素材 base64 编码畸形");
  const paddingLength = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  if (!hasCanonicalPaddingBits(encoded, paddingLength)) throw invalid("图片素材 base64 编码畸形");
  const expectedBytes = conservativeDecodedBytes - paddingLength;
  if (expectedBytes > MAX_MEDIA_IMAGE_BYTES) throw invalid("图片素材不能超过12 MiB");

  const decodeBase64 = options.decodeBase64 || ((payload) => Buffer.from(payload, "base64"));
  const buffer = decodeBase64(encoded);
  if (!Buffer.isBuffer(buffer)) throw invalid("图片素材 base64 编码畸形");
  if (buffer.length > MAX_MEDIA_IMAGE_BYTES) throw invalid("图片素材不能超过12 MiB");
  if (buffer.length !== expectedBytes) throw invalid("图片素材 base64 编码畸形");
  return { buffer, extension, mimeType };
}

function saveImageDataUrl(payload, mediaDir, options = {}) {
  const decoded = decodeImageDataUrl(payload?.dataUrl, options);
  const validate = options.validateImageBuffer || validateImageBuffer;
  const confirmed = validate(decoded.buffer, decoded.mimeType, { decodeImage: options.decodeImage, maxBytes: MAX_MEDIA_IMAGE_BYTES });
  const writeMedia = options.writeMedia;
  if (typeof writeMedia !== "function") throw new Error("图片素材写入组件不可用");
  const filename = writeMedia(mediaDir, decoded.buffer, confirmed.extension, "image");
  return { filename, extension: confirmed.extension, mimeType: confirmed.mimeType };
}

module.exports = { MAX_MEDIA_IMAGE_BYTES, decodeImageDataUrl, saveImageDataUrl };
