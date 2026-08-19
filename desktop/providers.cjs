const crypto = require("node:crypto");
const dns = require("node:dns");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { Readable } = require("node:stream");
const { FIRST_FRAME_SIZE_LIMIT_MESSAGE, MAX_PAID_VIDEO_FIRST_FRAME_BYTES, readPaidVideoFirstFrame } = require("./media-input.cjs");
const { detectImageMime, ffmpegPath, probeMediaFile, validateImageBuffer } = require("./media-tools.cjs");
const comfyui = require("./comfyui-provider.cjs");

const MAX_PROVIDER_IMAGE_BYTES = MAX_PAID_VIDEO_FIRST_FRAME_BYTES;
const MAX_PROVIDER_SPEECH_BYTES = 64 * 1024 * 1024;
const MAX_PROVIDER_VIDEO_BYTES = 1024 * 1024 * 1024;
const MAX_ENCODED_IMAGE_CHARS = Math.ceil(MAX_PROVIDER_IMAGE_BYTES / 3) * 4;
const MAX_IMAGE_JSON_OVERHEAD_BYTES = 1024 * 1024;
const MAX_IMAGE_JSON_ENVELOPE_BYTES = MAX_ENCODED_IMAGE_CHARS + MAX_IMAGE_JSON_OVERHEAD_BYTES;
const MAX_URL_JSON_ENVELOPE_BYTES = 1024 * 1024;
const MAX_MODELS_JSON_BYTES = 2 * 1024 * 1024;
const MAX_STORYBOARD_JSON_BYTES = 8 * 1024 * 1024;
const MAX_VIDEO_TASK_JSON_BYTES = 1024 * 1024;
const MAX_PROVIDER_JSON_DEPTH = 16;
const MAX_PROVIDER_JSON_NODES = 50_000;
const MAX_PROVIDER_JSON_ARRAY_ITEMS = 10_000;
const MAX_PROVIDER_JSON_OBJECT_KEYS = 1_000;
const MAX_PROVIDER_JSON_STRING_CODE_POINTS = 8 * 1024 * 1024;
const MAX_MEDIA_URL_LENGTH = 8 * 1024;
const MAX_MEDIA_REDIRECTS = 5;
const MEDIA_CONNECT_TIMEOUT_MS = 30_000;

function safeProviderIdentifier(value, maxLength = 160) {
  const text = typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  if (!text || text.length > maxLength || !/^[A-Za-z0-9_.:/-]+$/.test(text)) return "";
  return text;
}

function providerErrorDetails(data, response) {
  const providerCode = safeProviderIdentifier(
    data?.error?.code
      ?? data?.error?.status
      ?? data?.detail?.code
      ?? data?.detail?.status
      ?? data?.code
      ?? data?.error_code,
  );
  const requestId = safeProviderIdentifier(
    response?.headers?.get?.("x-request-id")
      || response?.headers?.get?.("x-tt-logid")
      || data?.request_id
      || data?.requestId
      || data?.detail?.request_id,
    200,
  );
  return { providerCode, requestId };
}

class ProviderHttpError extends Error {
  constructor(status, details = {}) {
    const safeStatus = Number.isInteger(Number(status)) && Number(status) >= 100 && Number(status) <= 599
      ? Number(status)
      : 500;
    const providerCode = safeProviderIdentifier(details.providerCode);
    const requestId = safeProviderIdentifier(details.requestId, 200);
    const detailText = [providerCode ? `错误码 ${providerCode}` : "", requestId ? `请求 ID ${requestId}` : ""].filter(Boolean).join("，");
    const privacyReferenceRejected = /InputImageSensitiveContentDetected\.PrivacyInformation/i.test(providerCode);
    const message = privacyReferenceRejected
      ? `Seedance 参考图触发了真人或隐私信息审核（HTTP ${safeStatus}${detailText ? `，${detailText}` : ""}）。这不是网络故障，同一张图反复重试仍会失败。请改用已获得本人授权并通过真人像库/可信素材库验证的 asset:// 素材，或改用不具可识别真人身份的虚构、风格化参考图；也可以切换本地 Wan 生成。`
      : `服务商拒绝了请求（HTTP ${safeStatus}${detailText ? `，${detailText}` : ""}）。请检查模型权限、请求参数与账户状态后重试。`;
    super(message);
    this.name = "ProviderHttpError";
    this.code = privacyReferenceRejected ? "PROVIDER_PRIVACY_REFERENCE_REJECTED" : "PROVIDER_HTTP_REJECTED";
    this.status = safeStatus;
    if (providerCode) this.providerCode = providerCode;
    if (requestId) this.requestId = requestId;
    if (privacyReferenceRejected) this.privacyReferenceRejected = true;
    this.definitiveRejection = true;
  }
}

const UNSAFE_IPV4_RANGES = [
  ["0.0.0.0", 8, "unspecified"],
  ["10.0.0.0", 8, "private"],
  ["100.64.0.0", 10, "carrier-grade NAT"],
  ["127.0.0.0", 8, "loopback"],
  ["169.254.0.0", 16, "link-local"],
  ["172.16.0.0", 12, "private"],
  ["192.0.0.0", 24, "reserved"],
  ["192.0.2.0", 24, "documentation"],
  ["192.88.99.0", 24, "reserved"],
  ["192.168.0.0", 16, "private"],
  ["198.18.0.0", 15, "benchmark"],
  ["198.51.100.0", 24, "documentation"],
  ["203.0.113.0", 24, "documentation"],
  ["224.0.0.0", 4, "multicast or reserved"],
  ["240.0.0.0", 4, "reserved"],
];

function ipv4Number(address) {
  const parts = String(address).split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part) || Number(part) > 255)) return null;
  return parts.reduce((value, part) => (value * 256 + Number(part)) >>> 0, 0);
}

function classifyIpv4(address) {
  const value = ipv4Number(address);
  if (value === null) return "invalid";
  for (const [network, prefix, reason] of UNSAFE_IPV4_RANGES) {
    const networkValue = ipv4Number(network);
    const divisor = 2 ** (32 - prefix);
    if (Math.floor(value / divisor) === Math.floor(networkValue / divisor)) return reason;
  }
  return "public";
}

function ipv6BigInt(address) {
  let value = String(address).toLowerCase().replace(/^\[|\]$/g, "").split("%", 1)[0];
  if (value.includes(".")) {
    const lastColon = value.lastIndexOf(":");
    const ipv4 = ipv4Number(value.slice(lastColon + 1));
    if (ipv4 === null) return null;
    value = `${value.slice(0, lastColon)}:${(ipv4 >>> 16).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const groups = [...left, ...Array(Math.max(0, missing)).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.reduce((result, group) => (result << 16n) | BigInt(`0x${group}`), 0n);
}

function ipv6InPrefix(value, network, prefix) {
  const networkValue = ipv6BigInt(network);
  return networkValue !== null && (prefix === 0 || (value >> BigInt(128 - prefix)) === (networkValue >> BigInt(128 - prefix)));
}

function classifyIpv6(address) {
  const value = ipv6BigInt(address);
  if (value === null) return "invalid";
  if (ipv6InPrefix(value, "::ffff:0:0", 96)) return classifyIpv4(`${Number((value >> 24n) & 255n)}.${Number((value >> 16n) & 255n)}.${Number((value >> 8n) & 255n)}.${Number(value & 255n)}`);
  for (const [network, prefix, reason] of [
    ["::", 128, "unspecified"], ["::1", 128, "loopback"], ["::", 96, "reserved"],
    ["64:ff9b::", 96, "translation"], ["64:ff9b:1::", 48, "translation"], ["100::", 64, "discard"],
    ["2001::", 23, "reserved"], ["2001:db8::", 32, "documentation"], ["2002::", 16, "transition"],
    ["3fff::", 20, "documentation"], ["5f00::", 16, "reserved"], ["fc00::", 7, "private"],
    ["fe80::", 10, "link-local"], ["fec0::", 10, "site-local"], ["ff00::", 8, "multicast"],
  ]) if (ipv6InPrefix(value, network, prefix)) return reason;
  if (!ipv6InPrefix(value, "2000::", 3)) return "reserved";
  return "public";
}

function normalizedHostname(url) {
  return url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function classifyAddress(address) {
  const normalized = String(address).replace(/^\[|\]$/g, "").split("%", 1)[0];
  const family = net.isIP(normalized);
  return { address: normalized, family, classification: family === 4 ? classifyIpv4(normalized) : family === 6 ? classifyIpv6(normalized) : "invalid" };
}

function parseMediaUrl(value) {
  const raw = String(value || "");
  if (!raw || raw.length > MAX_MEDIA_URL_LENGTH) throw new Error("Media URL length is invalid or exceeds the safety limit.");
  let url;
  try { url = new URL(raw); }
  catch { throw new Error("Media URL is invalid."); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Media URL protocol must be HTTP or HTTPS.");
  if (url.username || url.password) throw new Error("Media URL userinfo is not allowed.");
  if (!normalizedHostname(url)) throw new Error("Media URL hostname is missing.");
  return url;
}

function effectivePort(url) {
  return url.port || (url.protocol === "https:" ? "443" : "80");
}

function sameOrigin(left, right) {
  return left.protocol === right.protocol && normalizedHostname(left) === normalizedHostname(right) && effectivePort(left) === effectivePort(right);
}

function explicitlyPrivateBase(baseUrl) {
  const hostname = normalizedHostname(baseUrl);
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  const result = classifyAddress(hostname);
  return result.family > 0 && ["loopback", "private"].includes(result.classification);
}

async function resolveMediaHop(config, value, options = {}) {
  const url = parseMediaUrl(value);
  const base = parseMediaUrl(config?.baseUrl || "https://api.openai.com/v1");
  const privateTrustContext = explicitlyPrivateBase(base);
  if (privateTrustContext && !sameOrigin(base, url)) throw new Error("A private provider may return media only from the exact same origin.");
  const publicDefaultPort = url.protocol === "https:" ? "443" : "80";
  if (!privateTrustContext && effectivePort(url) !== publicDefaultPort) throw new Error("Media URL port is not allowed.");

  const hostname = normalizedHostname(url);
  if (!privateTrustContext && (hostname === "localhost" || hostname.endsWith(".localhost"))) throw new Error("Media URL address is not public and safe.");
  const literal = classifyAddress(hostname);
  let addresses;
  if (literal.family) addresses = [{ address: literal.address, family: literal.family, classification: literal.classification }];
  else {
    const resolver = options.resolver || ((name) => dns.promises.lookup(name, { all: true, verbatim: true }));
    let answers;
    try { answers = await resolver(hostname); }
    catch (error) { throw new Error(`Media URL DNS resolution failed: ${error instanceof Error ? error.message : String(error)}`); }
    if (!Array.isArray(answers) || !answers.length) throw new Error("Media URL DNS resolution returned no addresses.");
    addresses = answers.map((answer) => {
      const classified = classifyAddress(answer?.address);
      const declaredFamily = Number(answer?.family);
      if (![4, 6].includes(declaredFamily) || classified.family !== declaredFamily) return { ...classified, classification: "invalid" };
      return classified;
    });
    if (addresses.some((answer) => !answer.family || answer.classification === "invalid")) throw new Error("Media URL DNS resolution returned an invalid address.");
  }
  if (!privateTrustContext && addresses.some((answer) => answer.classification !== "public")) throw new Error("Media URL resolved to a non-public or unsafe address.");
  if (privateTrustContext && addresses.some((answer) => answer.classification === "invalid")) throw new Error("Private provider media URL resolved to an invalid address.");
  return { url, address: addresses[0].address, family: addresses[0].family };
}

function pinnedLookup(address, family) {
  return (_hostname, lookupOptions, callback) => {
    if (lookupOptions?.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

async function defaultMediaTransport(options) {
  const { url } = options;
  const client = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.request({
      protocol: url.protocol,
      hostname: normalizedHostname(url),
      port: effectivePort(url),
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: options.headers,
      lookup: options.lookup,
      family: options.family,
      ...(url.protocol === "https:" && net.isIP(normalizedHostname(url)) === 0 ? { servername: normalizedHostname(url) } : {}),
      agent: false,
    }, (incoming) => {
      incoming.setTimeout(options.timeoutMs, () => incoming.destroy(new Error("Media download timed out.")));
      resolve(new Response(Readable.toWeb(incoming), { status: incoming.statusCode || 500, headers: incoming.headers }));
    });
    request.setTimeout(options.timeoutMs, () => request.destroy(new Error("Media connection timed out.")));
    request.once("error", reject);
    request.end();
  });
}

async function secureMediaFetch(config, mediaUrl, options = {}) {
  let current = mediaUrl;
  for (let redirects = 0; ; redirects += 1) {
    const hop = await resolveMediaHop(config, current, options);
    const lookup = pinnedLookup(hop.address, hop.family);
    const response = await (options.transport || defaultMediaTransport)({
      url: hop.url,
      address: hop.address,
      family: hop.family,
      lookup,
      timeoutMs: options.timeoutMs || MEDIA_CONNECT_TIMEOUT_MS,
      headers: { Accept: "*/*", Host: hop.url.host },
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers?.get?.("location");
    try { await response.body?.cancel?.(); } catch { /* The redirect body is intentionally discarded. */ }
    if (!location) throw new Error("Media redirect is missing Location.");
    if (redirects >= MAX_MEDIA_REDIRECTS) throw new Error(`Media redirect limit of ${MAX_MEDIA_REDIRECTS} was exceeded.`);
    try { current = new URL(location, hop.url).href; }
    catch { throw new Error("Media redirect Location is invalid."); }
  }
}

function apiUrl(baseUrl, endpoint) {
  const base = String(baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  return `${base}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;
}

async function apiFetch(config, endpoint, init = {}) {
  if (!config?.apiKey) throw new Error("请先在“模型与偏好设置”中填写 API Key。");
  const response = await fetch(apiUrl(config.baseUrl, endpoint), {
    ...init,
    headers: {
      ...(config.kind === "elevenlabs" ? { "xi-api-key": config.apiKey } : { Authorization: `Bearer ${config.apiKey}` }),
      ...(init.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...(init.headers || {}),
    },
  });
  if (!response.ok) {
    let providerData;
    try {
      providerData = await readProviderJson(response, { maxBytes: MAX_URL_JSON_ENVELOPE_BYTES, label: "Provider 错误响应" });
    } catch { /* The untrusted response body is deliberately discarded. */ }
    throw new ProviderHttpError(response.status, providerErrorDetails(providerData, response));
  }
  return response;
}

function outputText(data) {
  if (typeof data?.output_text === "string") return data.output_text;
  for (const item of data?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === "string") return content.text;
    }
  }
  return "";
}

function parseJsonText(text) {
  const cleaned = String(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = Math.min(...[cleaned.indexOf("["), cleaned.indexOf("{")].filter((index) => index >= 0));
  const sliced = Number.isFinite(start) ? cleaned.slice(start) : cleaned;
  return JSON.parse(sliced);
}

function mediaPathFromUrl(mediaDir, mediaUrl) {
  if (!mediaUrl) return "";
  if (String(mediaUrl).startsWith("data:")) return "";
  try {
    const url = new URL(mediaUrl);
    const prefix = "/__media/";
    if (!url.pathname.startsWith(prefix)) return "";
    const name = path.basename(decodeURIComponent(url.pathname.slice(prefix.length)));
    const resolved = path.resolve(mediaDir, name);
    return resolved.startsWith(path.resolve(mediaDir) + path.sep) ? resolved : "";
  } catch { return ""; }
}

async function referencePart(mediaDir, mediaUrl, fallbackName) {
  if (!String(mediaUrl || "").trim()) return null;
  const input = readPaidVideoFirstFrame(mediaDir, mediaUrl);
  return { blob: new Blob([input.buffer], { type: input.mimeType }), name: input.name || fallbackName };
}

function referenceDataUrl(mediaDir, mediaUrl) {
  if (!String(mediaUrl || "").trim()) return "";
  const input = readPaidVideoFirstFrame(mediaDir, mediaUrl);
  return `data:${input.mimeType};base64,${input.buffer.toString("base64")}`;
}

function writeMedia(mediaDir, buffer, extension, prefix) {
  fs.mkdirSync(mediaDir, { recursive: true });
  const filename = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extension}`;
  fs.writeFileSync(path.join(mediaDir, filename), buffer);
  return filename;
}

function safeMediaToken(value, fallback) {
  const safe = String(value || fallback).replace(/[^a-z0-9_-]/gi, "-").slice(0, 40);
  return safe || fallback;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function boundedString(value, label, maxCodePoints, { required = false } = {}) {
  if (typeof value !== "string") throw new Error(`${label}必须是字符串`);
  let codePoints = 0;
  for (const unused of value) {
    void unused;
    codePoints += 1;
    if (codePoints > maxCodePoints) throw new Error(`${label}超过 ${maxCodePoints} 个 Unicode 字符的上限`);
  }
  if (required && !value.trim()) throw new Error(`${label}不能为空`);
  return value;
}

function assertBoundedProviderJson(value, options = {}) {
  const label = options.label || "Provider JSON 响应";
  const root = options.root || "object";
  if (root === "object" && !isPlainObject(value)) throw new Error(`${label}必须是普通对象`);
  if (root === "array" && !Array.isArray(value)) throw new Error(`${label}必须是数组`);
  const maxDepth = options.maxDepth || MAX_PROVIDER_JSON_DEPTH;
  const maxNodes = options.maxNodes || MAX_PROVIDER_JSON_NODES;
  const maxArrayItems = options.maxArrayItems || MAX_PROVIDER_JSON_ARRAY_ITEMS;
  const maxObjectKeys = options.maxObjectKeys || MAX_PROVIDER_JSON_OBJECT_KEYS;
  const maxStringCodePoints = options.maxStringCodePoints || MAX_PROVIDER_JSON_STRING_CODE_POINTS;
  const stack = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const current = stack.pop();
    nodes += 1;
    if (nodes > maxNodes) throw new Error(`${label}节点数量超过 ${maxNodes} 的上限`);
    if (current.depth > maxDepth) throw new Error(`${label}嵌套深度超过 ${maxDepth} 的上限`);
    if (typeof current.value === "string") {
      boundedString(current.value, `${label}字符串`, maxStringCodePoints);
      continue;
    }
    if (current.value === null || ["boolean", "number"].includes(typeof current.value)) continue;
    if (Array.isArray(current.value)) {
      if (current.value.length > maxArrayItems) throw new Error(`${label}数组项目超过 ${maxArrayItems} 的上限`);
      for (let index = 0; index < current.value.length; index += 1) {
        if (!Object.hasOwn(current.value, index)) throw new Error(`${label}不能包含稀疏数组`);
        stack.push({ value: current.value[index], depth: current.depth + 1 });
      }
      continue;
    }
    if (!isPlainObject(current.value)) throw new Error(`${label}包含非普通对象`);
    const keys = Object.keys(current.value);
    if (keys.length > maxObjectKeys) throw new Error(`${label}对象字段超过 ${maxObjectKeys} 的上限`);
    for (const key of keys) stack.push({ value: current.value[key], depth: current.depth + 1 });
  }
  return value;
}

async function readProviderJson(response, { maxBytes, label, root = "object", ...limits }) {
  const value = await readBoundedJsonResponse(response, { maxBytes });
  return assertBoundedProviderJson(value, { label, root, ...limits });
}

function responseUsesContentEncoding(response) {
  const encoding = String(response?.headers?.get?.("content-encoding") || "").trim().toLowerCase();
  return Boolean(encoding && encoding !== "identity");
}

async function readBoundedJsonResponse(response, options = {}) {
  const maxBytes = Number(options.maxBytes);
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("JSON 响应缺少有效大小上限");
  if (!response?.body || typeof response.body.getReader !== "function") throw new Error("JSON 响应不支持流式读取");
  const reader = response.body.getReader();
  const declaredText = response.headers?.get?.("content-length");
  const declaredLength = declaredText === null || declaredText === undefined || declaredText === "" ? null : Number(declaredText);
  const chunks = [];
  let totalBytes = 0;
  try {
    if (declaredLength !== null && (!/^\d+$/.test(String(declaredText)) || !Number.isSafeInteger(declaredLength) || declaredLength < 0)) throw new Error("JSON 响应 Content-Length 无效");
    if (declaredLength !== null && declaredLength > maxBytes) throw new Error(`JSON 响应 Content-Length 超过安全上限 ${maxBytes} 字节`);
    while (true) {
      let packet;
      try { packet = await reader.read(); }
      catch (error) { throw new Error(`JSON 响应传输中断：${error instanceof Error ? error.message : String(error)}`); }
      if (packet.done) break;
      if (!(packet.value instanceof Uint8Array) || packet.value.byteLength === 0) continue;
      if (totalBytes + packet.value.byteLength > maxBytes) throw new Error(`JSON 响应超过安全上限 ${maxBytes} 字节`);
      const view = Buffer.from(packet.value.buffer, packet.value.byteOffset, packet.value.byteLength);
      chunks.push(view);
      totalBytes += view.length;
    }
    // Fetch transparently decodes gzip/br bodies but preserves the compressed
    // Content-Length header. Only require byte-for-byte equality for identity
    // responses; the streamed decoded-byte limit remains enforced above.
    if (!responseUsesContentEncoding(response) && declaredLength !== null && totalBytes !== declaredLength) throw new Error("JSON 响应传输中断：实际字节数与 Content-Length 不一致");
    if (totalBytes <= 0) throw new Error("JSON 响应为空");
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, totalBytes)); }
    catch { throw new Error("JSON 响应不是有效 UTF-8"); }
    const parseJson = options.parseJson || JSON.parse;
    try { return parseJson(text); }
    catch (error) { throw new Error(`JSON 响应无法解析：${error instanceof Error ? error.message : String(error)}`); }
  } catch (error) {
    try { await reader.cancel(); } catch { /* Cleanup continues. */ }
    throw error;
  } finally {
    try { reader.releaseLock?.(); } catch { /* Cleanup continues. */ }
  }
}

async function publishImageBufferAtomic(mediaDir, buffer, extension, options = {}) {
  await fs.promises.mkdir(mediaDir, { recursive: true });
  const safeExtension = safeMediaToken(extension, "image");
  const token = `${Date.now()}-${crypto.randomBytes(10).toString("hex")}`;
  const temporary = path.join(mediaDir, `.image-${token}.part`);
  const filename = `image-${token}.${safeExtension}`;
  const destination = path.join(mediaDir, filename);
  let handle;
  try {
    handle = await fs.promises.open(temporary, "wx", 0o600);
    if (options.writeBuffer) await options.writeBuffer(handle, buffer);
    else await handle.writeFile(buffer);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await options.beforeRename?.({ temporary, destination });
    await fs.promises.rename(temporary, destination);
    return { filename };
  } finally {
    try { await handle?.close(); } catch { /* Cleanup continues. */ }
    await fs.promises.rm(temporary, { force: true }).catch(() => {});
  }
}

async function normalizeGeneratedImageAspect(mediaDir, filename, ratio) {
  const mediaRoot = path.resolve(mediaDir);
  const source = path.join(mediaRoot, path.basename(String(filename || "")));
  if (!filename || path.dirname(source) !== mediaRoot) throw new Error("生成图片路径无效");
  const portrait = ratio === "9:16";
  const width = portrait ? 864 : 1536;
  const height = portrait ? 1536 : 864;
  const token = `${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
  const temporary = path.join(mediaRoot, `.image-ratio-${token}.part`);
  const outputName = `image-${token}.jpg`;
  const destination = path.join(mediaRoot, outputName);
  const filter = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1`;
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(ffmpegPath(), ["-y", "-v", "error", "-i", source, "-vf", filter, "-frames:v", "1", "-c:v", "mjpeg", "-q:v", "2", "-f", "image2", temporary], { windowsHide: true });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4_000); });
      child.on("error", () => reject(new Error("无法启动图片比例处理器")));
      child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`图片比例处理失败：${stderr || `退出码 ${code}`}`)));
    });
    const output = await fs.promises.readFile(temporary);
    validateImageBuffer(output, "image/jpeg", { maxBytes: MAX_PROVIDER_IMAGE_BYTES });
    await fs.promises.rename(temporary, destination);
    await fs.promises.rm(source, { force: true });
    return { filename: outputName, width, height, ratio: portrait ? "9:16" : "16:9" };
  } finally {
    await fs.promises.rm(temporary, { force: true }).catch(() => {});
  }
}

async function streamResponseToMedia(response, mediaDir, options = {}) {
  const maxBytes = Number(options.maxBytes);
  if (!(maxBytes > 0)) throw new Error("媒体下载缺少有效大小上限");
  if (!response?.body || typeof response.body.getReader !== "function") throw new Error("媒体下载响应不支持流式读取");
  const declaredText = response.headers?.get?.("content-length");
  const declaredLength = declaredText === null || declaredText === undefined || declaredText === "" ? null : Number(declaredText);
  if (declaredLength !== null && (!/^\d+$/.test(String(declaredText)) || !Number.isSafeInteger(declaredLength) || declaredLength < 0)) throw new Error("媒体下载 Content-Length 无效");
  if (declaredLength !== null && declaredLength > maxBytes) throw new Error(`媒体下载 Content-Length 超过安全上限 ${maxBytes} 字节`);

  await fs.promises.mkdir(mediaDir, { recursive: true });
  const prefix = safeMediaToken(options.prefix, "media");
  const initialExtension = safeMediaToken(options.extension, "bin");
  const token = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
  const temporary = path.join(mediaDir, `.${prefix}-${token}.part`);
  let handle;
  let reader;
  let totalBytes = 0;
  try {
    handle = await fs.promises.open(temporary, "wx", 0o600);
    reader = response.body.getReader();
    while (true) {
      let packet;
      try { packet = await reader.read(); }
      catch (error) { throw new Error(`媒体下载传输中断：${error instanceof Error ? error.message : String(error)}`); }
      if (packet.done) break;
      const chunk = packet.value;
      if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0) continue;
      if (totalBytes + chunk.byteLength > maxBytes) throw new Error(`媒体下载超过安全上限 ${maxBytes} 字节`);
      const view = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      await handle.write(view, 0, view.length, totalBytes);
      totalBytes += view.length;
    }
    if (!responseUsesContentEncoding(response) && declaredLength !== null && totalBytes !== declaredLength) throw new Error("媒体下载传输中断：实际字节数与 Content-Length 不一致");
    if (totalBytes <= 0) throw new Error("媒体下载为空");
    await handle.sync();
    await handle.close();
    handle = undefined;
    const validation = typeof options.validateTemp === "function" ? await options.validateTemp(temporary, totalBytes, response) : null;
    const extension = safeMediaToken(validation?.extension || initialExtension, initialExtension);
    const filename = `${prefix}-${token}.${extension}`;
    await fs.promises.rename(temporary, path.join(mediaDir, filename));
    return { filename, bytes: totalBytes, validation };
  } catch (error) {
    try { await reader?.cancel?.(); } catch { /* Cleanup continues. */ }
    throw error;
  } finally {
    try { await handle?.close(); } catch { /* Cleanup continues. */ }
    try { reader?.releaseLock?.(); } catch { /* Cleanup continues. */ }
    await fs.promises.rm(temporary, { force: true }).catch(() => {});
  }
}

function decodeProviderImageBase64(encoded) {
  const value = String(encoded || "");
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error("图片服务返回的 base64 非法");
  if (value.length > MAX_ENCODED_IMAGE_CHARS) throw new Error("图片 base64 编码长度超过安全上限");
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const decodedBytes = (value.length / 4) * 3 - padding;
  if (decodedBytes > MAX_PROVIDER_IMAGE_BYTES) throw new Error("图片下载超过12 MiB安全上限");
  const buffer = Buffer.from(value, "base64");
  if (buffer.toString("base64") !== value) throw new Error("图片服务返回的 base64 非法或非规范编码");
  if (buffer.length > MAX_PROVIDER_IMAGE_BYTES) throw new Error("图片下载超过12 MiB安全上限");
  const mimeType = detectImageMime(buffer);
  if (!mimeType) throw new Error("图片服务返回的内容不是真实图片");
  const confirmed = validateImageBuffer(buffer, mimeType, { maxBytes: MAX_PROVIDER_IMAGE_BYTES });
  return { buffer, ...confirmed };
}

async function streamImageResponseToMedia(response, mediaDir) {
  const declaredMime = String(response.headers?.get?.("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  return streamResponseToMedia(response, mediaDir, {
    maxBytes: MAX_PROVIDER_IMAGE_BYTES,
    extension: "image",
    prefix: "image",
    validateTemp: async (temporary) => {
      const buffer = await fs.promises.readFile(temporary);
      const detected = detectImageMime(buffer);
      const mimeType = declaredMime || detected;
      if (!mimeType) throw new Error("图片下载内容不是真实图片");
      return validateImageBuffer(buffer, mimeType, { maxBytes: MAX_PROVIDER_IMAGE_BYTES });
    },
  });
}

async function testConnection(config) {
  const response = await apiFetch(config, "/models", { method: "GET" });
  const data = await readProviderJson(response, {
    maxBytes: MAX_MODELS_JSON_BYTES,
    label: "模型列表响应",
    root: config.kind === "elevenlabs" ? "array" : "object",
  });
  if (config.kind === "elevenlabs") {
    const models = Array.isArray(data) ? data : data?.models;
    if (!Array.isArray(models) || models.length > MAX_PROVIDER_JSON_ARRAY_ITEMS) throw new Error("ElevenLabs 模型列表响应无效。");
    return { ok: true, models: models.length };
  }
  if (!Array.isArray(data.data) || data.data.length > MAX_PROVIDER_JSON_ARRAY_ITEMS) throw new Error("模型列表响应缺少有界 data 数组");
  return { ok: true, models: data.data.length, modelIds: data.data.map((model) => safeProviderIdentifier(model?.id, 500)).filter(Boolean) };
}

function elevenLabsConnectionError(error) {
  if (!(error instanceof ProviderHttpError)) return error;
  const detail = [error.providerCode ? `错误码 ${error.providerCode}` : "", error.requestId ? `请求 ID ${error.requestId}` : ""].filter(Boolean).join("，");
  const context = `HTTP ${error.status}${detail ? `，${detail}` : ""}`;
  if (error.status === 401) return new Error(`ElevenLabs API Key 无效、已过期或已被停用（${context}）。`);
  if (error.status === 403) return new Error(`ElevenLabs API Key 没有读取该音色的权限，或启用了 IP 白名单（${context}）。`);
  if ([400, 404, 422].includes(error.status)) return new Error(`ElevenLabs 无法识别当前 Voice ID，或该音色不属于当前账户（${context}）。请从 ElevenLabs 的 Voices 页面重新复制 Voice ID。`);
  if (error.status === 429) return new Error(`ElevenLabs 请求受到速率或账户额度限制（${context}）。请稍后重试并检查账户额度。`);
  return error;
}

function elevenLabsSpeechError(error) {
  if (!(error instanceof ProviderHttpError)) return error;
  const detail = [error.providerCode ? `错误码 ${error.providerCode}` : "", error.requestId ? `请求 ID ${error.requestId}` : ""].filter(Boolean).join("，");
  const context = `HTTP ${error.status}${detail ? `，${detail}` : ""}`;
  const code = String(error.providerCode || "").toLowerCase();
  if (error.status === 401) return new Error(`ElevenLabs API Key 无效、已过期、被撤销或复制错误（${context}）。请在 ElevenLabs API Keys 页面新建密钥后重新保存。`);
  if (error.status === 403) return new Error(`ElevenLabs API Key 缺少 Text to Speech 权限，或启用了 IP 白名单（${context}）。`);
  if (code.includes("quota") || code.includes("credit") || code.includes("payment")) return new Error(`ElevenLabs 账户额度或付款状态不可用（${context}）。请检查账户 Credits 与账单状态。`);
  if (code.includes("voice")) return new Error(`ElevenLabs Voice ID 不可用或不属于当前账户（${context}）。请重新复制 Voice ID。`);
  if (code.includes("model")) return new Error(`当前 ElevenLabs 账户不能使用所选模型（${context}）。请确认模型为 eleven_v3 且账户已开通 API 权限。`);
  if ([400, 404, 422].includes(error.status)) return new Error(`ElevenLabs 拒绝了配音参数（${context}）。请先运行连接测试，并检查 Voice ID、eleven_v3 模型权限及单次 5,000 字符限制。`);
  if (error.status === 429) return new Error(`ElevenLabs 请求受到速率限制（${context}）。请稍后重试。`);
  return error;
}

async function testElevenLabsConnection(config) {
  const voiceId = boundedString(config?.voice, "ElevenLabs Voice ID", 500, { required: true }).trim();
  const model = boundedString(config?.voiceModel || "eleven_v3", "ElevenLabs 配音模型", 500, { required: true }).trim();
  try {
    const response = await apiFetch({ ...config, kind: "elevenlabs" }, `/voices/${encodeURIComponent(voiceId)}?with_settings=false`, { method: "GET" });
    const data = await readProviderJson(response, { maxBytes: MAX_MODELS_JSON_BYTES, label: "ElevenLabs 音色响应", root: "object" });
    if (String(data?.voice_id || "") !== voiceId) throw new Error("ElevenLabs 返回的 Voice ID 与当前设置不一致。");
    return { ok: true, voiceId, model };
  } catch (error) {
    throw elevenLabsConnectionError(error);
  }
}

function validateSeedanceModelId(value) {
  const model = String(value || "").trim();
  if (!model) throw new Error("请先填写 Seedance 模型 ID 或火山方舟控制台复制的 ep-… Endpoint ID。");
  if (!safeProviderIdentifier(model, 500)) throw new Error("Seedance 模型或 Endpoint ID 格式无效；已在付费请求前阻止提交。");
  return model;
}

async function testSeedanceConnection(config) {
  const model = validateSeedanceModelId(config?.videoModel);
  const result = await testConnection(config);
  const modelVisible = result.modelIds.includes(model);
  return { ok: true, models: result.models, model, modelVisible };
}

function seedanceRequestParameters(modelValue, requestedDuration, ratioValue, resolutionValue, requestedImageRole) {
  const model = validateSeedanceModelId(modelValue);
  const ratio = ratioValue === "9:16" ? "9:16" : "16:9";
  const normalizedModel = model.toLowerCase().replaceAll("_", "-");
  const maximumDuration = normalizedModel.includes("seedance-2-5") ? 30 : normalizedModel.includes("seedance-2-0") || /^ep-/i.test(model) ? 15 : 12;
  const requested = Math.round(Number(requestedDuration) || 5);
  const duration = Math.max(4, Math.min(maximumDuration, requested));
  const resolution = ["480p", "720p"].includes(String(resolutionValue || "").toLowerCase()) ? String(resolutionValue).toLowerCase() : "720p";
  const imageRole = requestedImageRole === "first_frame" ? "first_frame" : "reference_image";
  if (imageRole === "reference_image" && /seedance-1-(?:0|5)/i.test(normalizedModel)) {
    throw new Error("参考图驱动仅适用于 Seedance 2.x；当前 1.x 模型请改选“严格首帧”。已在付费请求前阻止提交。");
  }
  return { model, ratio, duration, resolution, imageRole };
}

function preflightVideoTask(config, payload) {
  const providerName = String(payload?.provider || "").trim();
  if (providerName !== "Seedance") throw new Error("OpenAI Video 已移除；视频生成请使用 Seedance。");
  const preparedFirstFrame = payload?.firstFrameInput;
  if (!preparedFirstFrame && payload?.imageUrl) {
    throw new Error(`首帧图片未经主进程大小与字节摘要校验；${FIRST_FRAME_SIZE_LIMIT_MESSAGE}，已在 POST 前阻止提交。`);
  }
  if (preparedFirstFrame) {
    if (!Buffer.isBuffer(preparedFirstFrame.buffer)
      || crypto.createHash("sha256").update(preparedFirstFrame.buffer).digest("hex") !== preparedFirstFrame.digest) {
      throw new Error("首帧缓冲区与付费请求指纹不一致，已在 POST 前阻止提交。");
    }
    validateImageBuffer(preparedFirstFrame.buffer, preparedFirstFrame.mimeType, { maxBytes: MAX_PROVIDER_IMAGE_BYTES });
    if (payload.enforceAspect === true && (!Number.isInteger(preparedFirstFrame.width) || !Number.isInteger(preparedFirstFrame.height))) {
      throw new Error("Seedance 首图无法确认真实宽高；请重新生成图片。已在付费请求前阻止提交。");
    }
    if (payload.enforceAspect === true && Number.isInteger(preparedFirstFrame.width) && Number.isInteger(preparedFirstFrame.height)) {
      const expectedRatio = payload.ratio === "9:16" ? 9 / 16 : 16 / 9;
      const actualRatio = preparedFirstFrame.width / preparedFirstFrame.height;
      if (Math.abs(actualRatio - expectedRatio) > 0.01) {
        throw new Error(`Seedance 首图比例与项目不一致：项目为 ${payload.ratio === "9:16" ? "9:16" : "16:9"}，首图为 ${preparedFirstFrame.width}×${preparedFirstFrame.height}。请先按项目比例重新生成图片；已在付费请求前阻止提交。`);
      }
    }
  }
  const parameters = seedanceRequestParameters(config?.videoModel, payload?.duration, payload?.ratio, payload?.resolution, payload?.imageRole);
  const cleanPrompt = String(payload?.prompt || "").replace(/\s+--(?:ratio|duration|dur)\s+\S+/gi, "").trim();
  if (!cleanPrompt) throw new Error("Seedance 视频提示词为空；已在付费请求前阻止提交。");
  return { ...parameters, cleanPrompt, preparedFirstFrame };
}

function videoPromptProfile(providerValue, modelValue, imageRoleValue) {
  const provider = String(providerValue || "").trim();
  const model = String(modelValue || "").trim();
  const identity = `${provider} ${model}`.toLowerCase();
  const imageRole = imageRoleValue === "first_frame" ? "严格首帧" : "参考图驱动";
  if (/wan(?:2|\s|[-_.])*2/i.test(identity)) {
    return `目标是 ${provider || "本地 ComfyUI"} / ${model || "Wan 2.2"}。按 Wan 图片转视频规范编写：把已批准分镜图视为运动起点，提示词聚焦主体动作、摄影机运动和环境微动，不重复静态外貌与场景；一个短镜头只安排一个主要动作和一次运镜，避免复杂时间码、连续转场和长串否定词。人物为侧脸、低头、脸部较小或正在行走时，必须保持输入图中的头部角度、侧脸方向、脸部大小和可见轮廓，只使用低幅度慢动作；不得快速转头、强行转正脸、使用夸张表情或连续口型，也不得让遮挡物掠过面部。人物和摄影机不得同时大幅运动，脸部像素不足时不得凭空补画五官。当前输入模式：${imageRole}。`;
  }
  if (/seedance|doubao.*video|豆包.*视频/i.test(identity)) {
    return `目标是 ${provider || "Seedance"} / ${model || "当前 Seedance 模型"}。按 Seedance 自然语言视频规范编写：明确主体、动作发展、运镜方向与幅度、节奏和结束状态；使用简洁连续的时序描述，不写命令行参数，不堆砌摄影术语。参考图模式下锁定人物与风格但允许自然构图变化；严格首帧模式下动作从输入画面自然开始。当前输入模式：${imageRole}。`;
  }
  if (/kling|可灵/i.test(identity)) {
    return `目标是 ${provider || "视频服务"} / ${model || "Kling"}。按 Kling 图生视频规范编写：优先写主体运动轨迹、动作幅度、速度、镜头运动和物理连续性；减少抽象情绪词和互相冲突的动作。当前输入模式：${imageRole}。`;
  }
  if (/hailuo|minimax|海螺/i.test(identity)) {
    return `目标是 ${provider || "视频服务"} / ${model || "Hailuo"}。按 Hailuo/MiniMax 图生视频规范编写：用短而具体的自然语言描述主体动作、表情、镜头运动与环境反馈，避免一个镜头包含多次动作反转。当前输入模式：${imageRole}。`;
  }
  if (/veo/i.test(identity)) {
    return `目标是 ${provider || "视频服务"} / ${model || "Veo"}。按 Veo 镜头提示规范编写：清楚描述场景、主体动作、摄影机、光线变化与镜头节奏；只有启用音频生成时才描述对白和声音。当前输入模式：${imageRole}。`;
  }
  return `目标是 ${provider || "当前视频服务商"} / ${model || "当前所选模型"}。请依据该具体模型的图生视频能力调整措辞；如果无法确认其专属语法，使用兼容性最高的自然语言结构：起始状态、一个主要动作、一次运镜、结束状态和简短稳定性约束，不虚构模型参数。当前输入模式：${imageRole}。`;
}

async function createStoryboard(config, payload) {
  const shortDrama = payload?.creationMode === "short_drama";
  const videoProvider = boundedString(payload?.videoProvider || "", "视频服务商", 200);
  const videoModel = boundedString(payload?.videoModel || "", "视频模型", 500);
  const videoPromptRules = videoPromptProfile(videoProvider, videoModel, payload?.videoImageRole);
  const prompt = `请把下面的中文${shortDrama ? "短剧剧本" : "解说文稿"}设计成细致、可制作、符合电影叙事语言的视频分镜。只输出 JSON 数组，不要 Markdown。每项必须包含 narration、duration、visual、shotType、camera、imagePrompt、videoPrompt${shortDrama ? "，并包含 scene、speaker、dialogue、extras（没有时用空字符串）" : ""}。

硬性要求：
1. 不能机械地按固定 3 秒切镜头。duration 必须服从叙事节拍和镜头功能：环境建立、空间交代、重要情绪停顿约 4–5.5 秒；普通动作与关系推进约 3–4 秒；反应、物件细节和视线匹配约 2–3 秒。完整动作和重要语句不得从中间硬切。
2. 保持原文顺序、逐字完整覆盖解说文稿，不得改写、漏字、重复或把解说文稿写进画面。
3. 每个镜头只表达一个清楚的视觉信息或动作节点，长句拆成多个连续镜头。
4. 使用电影叙事镜头组：建立环境的远景/全景、交代人物关系的中景、推进动作的近景、强调情绪的人物特写、补充线索的手部或物件细节、承接剪辑的反应镜头与视线匹配镜头。${shortDrama ? "对白必须按说话人近景、过肩反打、倾听者反应和双人关系镜头组织，保持轴线、视线和人物站位连续。" : ""}
5. 相邻镜头不得连续使用相同景别；同一场景至少形成“空间建立—动作推进—情绪/细节回应”的景别变化，避免无意义跳切。
5a. shotType 必须只从以下标准景别中选择：大远景、远景、全景、中全景、中景、中近景、近景、特写、大特写、过肩镜头、主观镜头；不要把机位或运镜写进 shotType，camera 单独填写。
6. camera 必须具体且克制，例如固定、缓慢推进、轻微横移、跟拍、视线匹配切换；不要每个镜头都大幅运动。
7. visual 与 imagePrompt 要写明主体、动作、人物表情、环境层次、构图和光线；角色只在文稿明确涉及时出镜。
8. videoPrompt 必须遵守当前目标模型的提示词规范：${videoPromptRules} 每条控制在 120–260 个汉字，只写图片生成后需要发生的动态变化；包含一个主要动作、至多一个自然反应、一次摄影机运动、结尾状态和最多五项稳定性约束。运动幅度必须能在 duration 内真实完成。
8a. 人物为侧脸、低头、脸部较小或正在行走时，videoPrompt 必须优先身份稳定：保持输入画面中的头部角度、侧脸方向和脸部大小，降低动作幅度；不得把快速转头、夸张表情、连续口型、遮挡物扫过面部或大幅运镜叠加到同一镜头；人物与摄影机不得同时大幅运动，脸部像素不足时不得凭空补画五官。
${shortDrama ? "9. scene 要继承当前场景；speaker 只写说话角色；dialogue 只写说出的台词；extras 写群众类型与数量。群众只做背景调度，不得抢占主角视觉中心。竖版强调面部微表情和纵深调度；横版强调人物关系与空间调度。" : ""}

画面比例：${payload.ratio}
叙事节奏：${payload.pace || "自然"}
统一风格：${payload.style}
角色设定：${JSON.stringify(payload.characters || [])}
${shortDrama ? "短剧剧本" : "解说文稿"}：
${payload.script}`;
  const response = await apiFetch(config, "/responses", {
    method: "POST",
    body: JSON.stringify({ model: config.storyboardModel || "gpt-5.6", reasoning: { effort: "low" }, input: prompt }),
  });
  const data = await readProviderJson(response, { maxBytes: MAX_STORYBOARD_JSON_BYTES, label: "分镜模型响应" });
  const parsed = parseJsonText(outputText(data));
  assertBoundedProviderJson(parsed, { label: "分镜内容", root: Array.isArray(parsed) ? "array" : "object", maxArrayItems: 500, maxNodes: 20_000, maxStringCodePoints: 100_000 });
  const shots = Array.isArray(parsed) ? parsed : parsed.shots;
  if (!Array.isArray(shots) || !shots.length || shots.length > 500 || shots.some((shot) => !isPlainObject(shot))) throw new Error("模型没有返回可用的有界分镜数组。");
  return { shots };
}

async function createCharacterProfile(config, payload) {
  const script = boundedString(payload?.script, "角色文稿", 100_000, { required: true });
  const name = boundedString(payload?.name, "角色称呼", 200, { required: true });
  const style = boundedString(payload?.style || "", "全片风格", 10_000);
  const stages = Array.isArray(payload?.stages) ? payload.stages.filter((stage) => ["child", "adult", "elder"].includes(stage)).slice(0, 3) : [];
  const stageText = stages.length > 1 ? `文稿包含跨年龄阶段（${stages.join("、")}）。必须把它们写成同一个人的自然年龄变化：眼型、鼻型、唇形、脸部骨骼、发色和标志性神态保持一致，只允许年龄、身高、体型成熟度和阶段服装变化。` : "";
  const prompt = `请根据解说文稿，为主角“${name}”设计一份可长期保持画面一致性的中文身份设定。先判断文稿真正围绕谁展开，不要把父亲、母亲或一次性配角误当主角。只输出 JSON 对象，不要 Markdown，格式为 {"description":"..."}。description 必须具体写明年龄阶段、面部轮廓、眼型、鼻型、唇形、发型发色、体型、固定服装配色和一件可识别的随身物品。${stageText}不要添加文稿冲突的身份，不要包含镜头动作、背景、文字或水印，控制在 260 个汉字以内。\n\n全片风格：${style}\n解说文稿：\n${script}`;
  const response = await apiFetch(config, "/responses", {
    method: "POST",
    body: JSON.stringify({ model: config.storyboardModel || "gpt-5.6", reasoning: { effort: "low" }, input: prompt }),
  });
  const data = await readProviderJson(response, { maxBytes: MAX_STORYBOARD_JSON_BYTES, label: "角色提示词模型响应" });
  const parsed = parseJsonText(outputText(data));
  assertBoundedProviderJson(parsed, { label: "角色提示词内容", root: "object", maxNodes: 100, maxStringCodePoints: 4_000 });
  const description = boundedString(parsed.description, "角色外观设定", 2_000, { required: true }).trim();
  return { description };
}

async function optimizeImagePrompt(config, payload) {
  const narration = boundedString(payload?.narration, "镜头文案", 20_000, { required: true });
  const visual = boundedString(payload?.visual, "画面描述", 20_000, { required: true });
  const currentPrompt = boundedString(payload?.currentPrompt || "", "当前图片提示词", 30_000);
  const style = boundedString(payload?.style || "", "全片风格", 10_000);
  const ratio = payload?.ratio === "9:16" ? "9:16" : "16:9";
  const characters = Array.isArray(payload?.characters) ? payload.characters.slice(0, 10).map((character) => ({
    name: boundedString(character?.name || "", "角色称呼", 200),
    stage: ["child", "adult", "elder"].includes(character?.stage) ? character.stage : "adult",
    description: boundedString(character?.description || "", "角色设定", 4_000),
  })) : [];
  const instruction = `请把当前镜头的图片生成提示词优化成一段可直接用于图片模型的中文提示词。只输出 JSON 对象，不要 Markdown，格式为 {"prompt":"..."}。

硬性要求：
1. 忠于镜头文案和画面描述，不得改剧情、增加无关人物、遗漏关键动作或把字幕画进画面。
2. 明确写出人物真实可信的表情：眼神方向、眉间、嘴角、面部张力和身体姿态必须符合台词的潜台词；禁止所有场景都微笑，禁止摆拍和夸张表演。
3. 补全主体动作、人物关系、景别、构图、光线、环境层次、镜头焦段感和前后景，但不要堆砌互相冲突的形容词。
4. 严格使用角色年龄阶段和身份设定；童年版不得写成成年人，成年版不得写成儿童。
5. 保持全片风格与 ${ratio} 构图，结尾写明无文字、无水印、无多余人物。控制在 500 个汉字以内。

镜头文案：${narration}
画面描述：${visual}
角色与年龄阶段：${JSON.stringify(characters)}
全片风格：${style}
当前提示词：${currentPrompt}`;
  const response = await apiFetch(config, "/responses", {
    method: "POST",
    body: JSON.stringify({ model: config.storyboardModel || "gpt-5.6", reasoning: { effort: "low" }, input: instruction }),
  });
  const data = await readProviderJson(response, { maxBytes: MAX_STORYBOARD_JSON_BYTES, label: "提示词优化模型响应" });
  const parsed = parseJsonText(outputText(data));
  assertBoundedProviderJson(parsed, { label: "优化提示词内容", root: "object", maxNodes: 100, maxStringCodePoints: 10_000 });
  const prompt = boundedString(parsed.prompt, "优化后的图片提示词", 5_000, { required: true }).trim();
  return { prompt };
}

async function optimizeVideoPrompt(config, payload) {
  const narration = boundedString(payload?.narration, "镜头文案", 20_000, { required: true });
  const visual = boundedString(payload?.visual, "画面描述", 20_000, { required: true });
  const currentPrompt = boundedString(payload?.currentPrompt || "", "当前视频提示词", 30_000);
  const style = boundedString(payload?.style || "", "全片风格", 10_000);
  const shotType = boundedString(payload?.shotType || "", "景别", 500);
  const camera = boundedString(payload?.camera || "", "运镜", 1_000);
  const duration = Math.max(1, Math.min(60, Number(payload?.duration) || 5));
  const ratio = payload?.ratio === "9:16" ? "9:16" : "16:9";
  const imageRole = payload?.imageRole === "first_frame" ? "严格首帧" : "参考图驱动";
  const videoProvider = boundedString(payload?.videoProvider || "", "视频服务商", 200);
  const videoModel = boundedString(payload?.videoModel || "", "视频模型", 500);
  const videoPromptRules = videoPromptProfile(videoProvider, videoModel, payload?.imageRole);
  const faceVisibility = ["visible", "partial", "hidden"].includes(payload?.faceVisibility) ? payload.faceVisibility : "visible";
  const characters = Array.isArray(payload?.characters) ? payload.characters.slice(0, 10).map((character) => ({
    name: boundedString(character?.name || "", "角色称呼", 200),
    stage: ["child", "adult", "elder"].includes(character?.stage) ? character.stage : "adult",
    description: boundedString(character?.description || "", "角色设定", 4_000),
    hasMasterImage: character?.hasMasterImage === true,
  })) : [];
  const instruction = `请把当前镜头的视频生成提示词优化成一段可直接提交 ${videoProvider || "视频服务商"} / ${videoModel || "当前所选模型"} 的中文动态提示词。只输出 JSON 对象，不要 Markdown，格式为 {"prompt":"..."}。

硬性要求：
0. 先遵守目标模型专属规范：${videoPromptRules} 当用户以后切换服务商或模型时，必须按这里给出的实际名称切换写法，不得继续套用上一模型的习惯。
1. 严格忠于镜头文案、画面描述和角色年龄，不改剧情、不增加无关人物。
2. 这是图片驱动视频，不要重复罗列参考图已经确定的建筑、服装、五官、光线、风格和比例；提示词只写“会发生什么变化”。
3. 按 ${duration} 秒只安排一个主要动作、至多一个自然反应和一次摄影机运动。动作必须能在时长内真实完成；禁止塞入多段时间码、连续转场、瞬移或动作跳变。
4. 固定顺序：镜头时长与初始状态 → 主体动作及必要表情/视线 → 摄影机方向、速度和停止位置 → 最多两项环境微动 → 简短稳定性约束。不要写成分镜说明书。
5. 摄影机符合“${shotType} / ${camera}”，只保留最有叙事价值的一种运镜，写清方向和幅度；不得同时推进、横移、环绕、升降。
6. 当前使用“${imageRole}”。${/wan(?:2|\s|[-_.])*2/i.test(videoModel) ? "当前 Wan 工作流会把分镜图作为实际起始参考，动作必须从图中姿态自然延续。侧脸、低头或脸部较小时，必须保持输入图中的头部角度、侧脸方向和脸部大小，使用低幅度慢动作；人物与摄影机不得同时大幅运动，脸部像素不足时不得凭空补画五官。" : imageRole === "参考图驱动" ? "参考图用于锁定人物、场景和风格，不要求机械复制首帧构图。" : "视频必须从输入画面自然开始。"}
7. 角色母版已经先用于生成分镜图，视频阶段应从这张已批准分镜图继承身份，不要在提示词中重新创造另一张脸。当前脸部可见状态为“${faceVisibility}”：${faceVisibility === "hidden" ? "人物为背影或脸不可见，不得要求眼神、眉眼、嘴角或五官变化，不得强行转身露出正脸；只保持体型、发型轮廓、服装、步态和背向姿态。" : faceVisibility === "partial" ? "严格继承分镜图中的头部角度、侧脸方向、脸部大小和当前可见轮廓；只允许低幅度慢动作，不强行转正脸，不做快速转头、夸张表情或连续口型，不让遮挡物掠过面部，人物与摄影机不得同时大幅运动；脸部像素不足时不得凭空补画五官。" : "保持参考图中的年龄、五官比例和脸部大小，只描述一项克制的微表情或视线变化；不得快速转头或连续口型，人物与摄影机不得同时大幅运动。"}
8. 稳定性约束最多保留五项，优先：身份不变、身体结构正常、主体不漂移、画面不闪烁、不新增人物。不要堆砌长串否定词。
9. 最终控制在 120–260 个汉字；短句、可执行、没有重复形容词。输出前自行删掉所有不影响运动结果的静态描述。

镜头文案：${narration}
画面描述：${visual}
角色与年龄阶段：${JSON.stringify(characters)}
画面比例：${ratio}
全片风格：${style}
当前视频提示词：${currentPrompt}`;
  const response = await apiFetch(config, "/responses", {
    method: "POST",
    body: JSON.stringify({ model: config.storyboardModel || "gpt-5.6", reasoning: { effort: "low" }, input: instruction }),
  });
  const data = await readProviderJson(response, { maxBytes: MAX_STORYBOARD_JSON_BYTES, label: "视频提示词优化模型响应" });
  const parsed = parseJsonText(outputText(data));
  assertBoundedProviderJson(parsed, { label: "优化视频提示词内容", root: "object", maxNodes: 100, maxStringCodePoints: 10_000 });
  const rawPrompt = boundedString(parsed.prompt, "优化后的视频提示词", 6_000, { required: true }).replace(/\s+/g, " ").trim();
  const codePoints = Array.from(rawPrompt);
  let prompt = rawPrompt;
  if (codePoints.length > 260) {
    const candidate = codePoints.slice(0, 260).join("");
    const sentenceCut = Math.max(candidate.lastIndexOf("。"), candidate.lastIndexOf("；"));
    const phraseCut = Math.max(candidate.lastIndexOf("，"), candidate.lastIndexOf(","));
    const cutAt = sentenceCut >= 150 ? sentenceCut + 1 : phraseCut >= 180 ? phraseCut : 260;
    prompt = `${candidate.slice(0, cutAt).replace(/[，,；;。\s]+$/u, "")}。`;
  }
  return { prompt };
}

async function analyzeStyleReference(config, payload, mediaDir) {
  const imageUrl = boundedString(payload?.imageUrl || "", "风格参考图", MAX_MEDIA_URL_LENGTH, { required: true });
  const existingPrompt = boundedString(payload?.existingPrompt || "", "现有自定义风格提示词", 10_000);
  const ratio = payload?.ratio === "9:16" ? "9:16" : "16:9";
  const imageDataUrl = referenceDataUrl(mediaDir, imageUrl);
  if (!imageDataUrl) throw new Error("请先导入风格参考图");
  const instruction = `分析所附图片的视觉风格，并把分析结果改写成可以复用于整条视频的中文全局风格提示词。只输出 JSON 对象，不要 Markdown，格式为 {"prompt":"..."}。

硬性要求：
1. 只分析色调、色彩关系、饱和度与反差、光线方向和质感、材质纹理、颗粒、构图、焦段感、景深、镜头语言和整体氛围。
2. 忽略并且不得描述或复用图片中的人物身份、面部、具体人物、具体物品、地点、文字、标志、商标、作品角色或剧情内容。
3. 提示词必须具有跨场景复用性，适用于 ${ratio} 视频；补充与该风格匹配的克制运镜建议，但不要要求每个镜头出现相同主体或相同构图。
4. 结尾写明保持全片视觉一致、人物身份由角色母版另行控制、无文字、无水印。控制在 180 到 350 个汉字。
5. 如果现有提示词不为空，只把它当作用户偏好进行融合，不要照抄其中的具体人物或内容。

现有提示词：${existingPrompt}`;
  const response = await apiFetch(config, "/responses", {
    method: "POST",
    body: JSON.stringify({
      model: config.storyboardModel || "gpt-5.6",
      reasoning: { effort: "low" },
      input: [{ role: "user", content: [{ type: "input_text", text: instruction }, { type: "input_image", image_url: imageDataUrl }] }],
    }),
  });
  const data = await readProviderJson(response, { maxBytes: MAX_STORYBOARD_JSON_BYTES, label: "风格参考图分析响应" });
  const parsed = parseJsonText(outputText(data));
  assertBoundedProviderJson(parsed, { label: "风格参考图分析内容", root: "object", maxNodes: 100, maxStringCodePoints: 10_000 });
  const prompt = boundedString(parsed.prompt, "分析后的自定义风格提示词", 5_000, { required: true }).trim();
  return { prompt };
}

async function createImage(config, payload, mediaDir, onProgress, mediaDownloadOptions = {}) {
  onProgress?.("generating");
  const references = [payload.imageUrl, ...(payload.references || [])].filter(Boolean);
  let response;
  let responseEnvelopeLimit = MAX_IMAGE_JSON_ENVELOPE_BYTES;
  if (/Seedream/i.test(String(payload.provider || ""))) {
    if (!config.imageModel) throw new Error("请在 API 设置中填写 Seedream 模型 ID。");
    const images = references.slice(0, 4).map((reference) => referenceDataUrl(mediaDir, reference)).filter(Boolean);
    response = await apiFetch(config, "/images/generations", {
      method: "POST",
      body: JSON.stringify({ model: config.imageModel, prompt: payload.prompt, ...(images.length ? { image: images } : {}), size: "2K", sequential_image_generation: "disabled", response_format: "url", watermark: false }),
    });
    responseEnvelopeLimit = MAX_URL_JSON_ENVELOPE_BYTES;
  } else if (references.length) {
    const form = new FormData();
    form.append("model", config.imageModel || "gpt-image-2");
    form.append("prompt", payload.prompt);
    form.append("size", payload.ratio === "9:16" ? "1024x1536" : "1536x1024");
    let appended = 0;
    for (const [index, reference] of references.slice(0, 4).entries()) {
      const part = await referencePart(mediaDir, reference, `reference-${index}.png`);
      if (part) { form.append("image[]", part.blob, part.name); appended += 1; }
    }
    if (appended) response = await apiFetch(config, "/images/edits", { method: "POST", body: form });
  }
  if (!response) {
    response = await apiFetch(config, "/images/generations", {
      method: "POST",
      body: JSON.stringify({ model: config.imageModel || "gpt-image-2", prompt: payload.prompt, size: payload.ratio === "9:16" ? "1024x1536" : "1536x1024", quality: "medium" }),
    });
  }
  const data = await readProviderJson(response, {
    maxBytes: responseEnvelopeLimit,
    label: "图片生成响应",
    maxStringCodePoints: MAX_ENCODED_IMAGE_CHARS,
  });
  const image = data?.data?.[0];
  let buffer;
  let extension;
  if (image?.b64_json) {
    const decoded = decodeProviderImageBase64(image.b64_json);
    buffer = decoded.buffer;
    extension = decoded.extension;
  }
  else if (image?.url) {
    onProgress?.("downloading");
    const imageResponse = await secureMediaFetch(config, image.url, mediaDownloadOptions);
    if (!imageResponse.ok) throw new Error("图片下载失败。");
    const streamed = await streamImageResponseToMedia(imageResponse, mediaDir);
    return payload.enforceAspect === true
      ? normalizeGeneratedImageAspect(mediaDir, streamed.filename, payload.ratio)
      : { filename: streamed.filename };
  }
  else throw new Error("图片服务没有返回可用画面。");
  const published = await publishImageBufferAtomic(mediaDir, buffer, extension);
  return payload.enforceAspect === true
    ? normalizeGeneratedImageAspect(mediaDir, published.filename, payload.ratio)
    : published;
}

async function submitVideoTask(config, payload) {
  const { model, ratio, duration, resolution, imageRole, cleanPrompt, preparedFirstFrame } = preflightVideoTask(config, payload);
  const content = [{ type: "text", text: cleanPrompt }];
  const firstFrame = preparedFirstFrame
    ? `data:${preparedFirstFrame.mimeType};base64,${preparedFirstFrame.buffer.toString("base64")}`
    : "";
  if (firstFrame) content.push({ type: "image_url", image_url: { url: firstFrame }, role: imageRole });
  const response = await apiFetch(config, "/contents/generations/tasks", {
    method: "POST",
    body: JSON.stringify({
      model,
      content,
      resolution,
      ratio,
      duration,
      generate_audio: payload?.generateAudio === true,
    }),
  });
  const job = await readProviderJson(response, { maxBytes: MAX_VIDEO_TASK_JSON_BYTES, label: "Seedance 提交响应" });
  boundedString(job?.id, "Seedance 任务 ID", 1_000, { required: true });
  if (job.status !== undefined) boundedString(job.status, "Seedance 任务状态", 100);
  return { jobId: job.id, status: job.status || "queued" };
}

async function pollVideoTask(config, payload, mediaDir, onProgress, mediaDownloadOptions = {}) {
  const jobId = String(payload?.jobId || "").trim();
  if (!jobId) throw new Error("缺少视频任务 ID；为避免重复计费，已阻止重新提交。");
  const providerName = String(payload?.provider || "").trim();
  if (providerName === "Seedance") {
    const response = await apiFetch(config, `/contents/generations/tasks/${encodeURIComponent(jobId)}`, { method: "GET" });
    const job = await readProviderJson(response, { maxBytes: MAX_VIDEO_TASK_JSON_BYTES, label: "Seedance 轮询响应" });
    boundedString(job?.status, "Seedance 任务状态", 100, { required: true });
    if (["queued", "running"].includes(job.status)) return { jobId, status: job.status };
    if (["canceled", "cancelled"].includes(job.status)) return { jobId, status: "canceled" };
    if (job.status !== "succeeded" || !job?.content?.video_url) return { jobId, status: "failed", error: "Seedance 视频生成失败；服务商未提供可用视频。" };
    onProgress?.("downloading");
    const videoResponse = await secureMediaFetch(config, job.content.video_url, mediaDownloadOptions);
    if (!videoResponse.ok) throw new Error("Seedance 视频下载失败。");
    const downloaded = await streamResponseToMedia(videoResponse, mediaDir, {
      maxBytes: MAX_PROVIDER_VIDEO_BYTES,
      extension: "mp4",
      prefix: "video",
      validateTemp: async (temporary) => { await probeMediaFile(temporary, "video"); },
    });
    return { filename: downloaded.filename, jobId, status: "succeeded" };
  }
  if (providerName !== "OpenAI Video") throw new Error("不支持的视频服务商；视频生成请使用 Seedance。");
  // Only existing paid OpenAI Video tasks may reach this legacy polling path.
  let response = await apiFetch(config, `/videos/${encodeURIComponent(jobId)}`, { method: "GET" });
  const job = await readProviderJson(response, { maxBytes: MAX_VIDEO_TASK_JSON_BYTES, label: "视频轮询响应" });
  boundedString(job?.status, "视频任务状态", 100, { required: true });
  if (["queued", "in_progress"].includes(job.status)) return { jobId, status: job.status };
  if (["canceled", "cancelled"].includes(job.status)) return { jobId, status: "canceled" };
  if (job.status !== "completed") return { jobId, status: "failed", error: "视频生成失败；服务商未提供可用视频。" };
  onProgress?.("downloading");
  response = await apiFetch(config, `/videos/${encodeURIComponent(jobId)}/content`, { method: "GET" });
  const downloaded = await streamResponseToMedia(response, mediaDir, {
    maxBytes: MAX_PROVIDER_VIDEO_BYTES,
    extension: "mp4",
    prefix: "video",
    validateTemp: async (temporary) => { await probeMediaFile(temporary, "video"); },
  });
  return { filename: downloaded.filename, jobId, status: "completed" };
}

async function createSpeech(config, payload, mediaDir) {
  if (config.kind === "elevenlabs" || /ElevenLabs/i.test(String(payload?.provider || ""))) {
    const voiceId = boundedString(payload?.voice || config.voice || "", "ElevenLabs Voice ID", 500, { required: true }).trim();
    const modelId = boundedString(config.voiceModel || "eleven_v3", "ElevenLabs 配音模型", 500, { required: true }).trim();
    const text = boundedString(payload?.text, "配音文稿", 100_000, { required: true });
    const maximumCharacters = modelId === "eleven_v3" ? 5_000 : /flash_v2_5/i.test(modelId) ? 40_000 : 10_000;
    const characterCount = Array.from(text).length;
    if (characterCount > maximumCharacters) throw new Error(`当前 ${modelId} 单次最多支持 ${maximumCharacters.toLocaleString("en-US")} 个字符，文稿共有 ${characterCount.toLocaleString("en-US")} 个字符。请缩短文稿或拆分项目后生成。`);
    let response;
    try {
      response = await apiFetch({ ...config, kind: "elevenlabs" }, `/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
        method: "POST",
        body: JSON.stringify({ text, model_id: modelId, ...(/[\u3400-\u9fff]/u.test(text) ? { language_code: "zh" } : {}) }),
      });
    } catch (error) {
      throw elevenLabsSpeechError(error);
    }
    const downloaded = await streamResponseToMedia(response, mediaDir, {
      maxBytes: MAX_PROVIDER_SPEECH_BYTES,
      extension: "mp3",
      prefix: "voice-elevenlabs",
      validateTemp: async (temporary) => { await probeMediaFile(temporary, "audio"); },
    });
    return { filename: downloaded.filename };
  }
  const response = await apiFetch(config, "/audio/speech", {
    method: "POST",
    body: JSON.stringify({
      model: config.voiceModel || "gpt-4o-mini-tts",
      voice: payload.voice || config.voice || "coral",
      input: payload.text,
      instructions: payload.instructions || "使用自然、清晰、有叙事感的普通话朗读，节奏平稳。",
      response_format: "mp3",
    }),
  });
  const downloaded = await streamResponseToMedia(response, mediaDir, {
    maxBytes: MAX_PROVIDER_SPEECH_BYTES,
    extension: "mp3",
    prefix: "voice",
    validateTemp: async (temporary) => { await probeMediaFile(temporary, "audio"); },
  });
  return { filename: downloaded.filename };
}

function demoSpeechPlan(platform, output) {
  if (platform === "darwin") {
    return {
      executable: "/usr/bin/say",
      args: ["-o", output, "--data-format=LEI16@22050"],
      extension: "aiff",
      source: "macos-say-demo",
    };
  }
  if (platform === "win32") {
    return { executable: "powershell", args: [], extension: "wav", source: "windows-sapi-demo" };
  }
  throw new Error("当前系统不支持本地演示配音，请在设置中填写 OpenAI 或 ElevenLabs API 后生成配音。");
}

function createDemoSpeech(payload, mediaDir) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(mediaDir, { recursive: true });
    const preliminary = demoSpeechPlan(process.platform, "");
    const filename = `voice-demo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${preliminary.extension}`;
    const output = path.join(mediaDir, filename);
    if (process.platform === "darwin") {
      const plan = demoSpeechPlan(process.platform, output);
      const child = spawn(plan.executable, plan.args, { stdio: ["pipe", "ignore", "pipe"] });
      let errors = "";
      child.stderr.on("data", (chunk) => { errors += chunk; });
      child.on("error", () => reject(new Error("无法启动 macOS 本地配音服务。")));
      child.on("close", (code) => code === 0 && fs.existsSync(output) && fs.statSync(output).size > 128
        ? resolve({ filename, source: plan.source })
        : reject(new Error(errors.trim() || "当前 macOS 没有可用的本地语音，请在设置中填写 OpenAI 或 ElevenLabs API 后生成配音。")));
      child.stdin.end(String(payload?.text || ""));
      return;
    }
    const text64 = Buffer.from(String(payload?.text || ""), "utf8").toString("base64");
    const safeOutput = output.replace(/'/g, "''");
    const script = `$t=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${text64}')); $v=New-Object -ComObject SAPI.SpVoice; $f=New-Object -ComObject SAPI.SpFileStream; $f.Open('${safeOutput}',3,$false); $v.AudioOutputStream=$f; $null=$v.Speak($t); $f.Close()`;
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const executable = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const child = spawn(executable, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { windowsHide: true });
    let errors = "";
    child.stderr.on("data", (chunk) => { errors += chunk; });
    child.on("error", () => reject(new Error("无法启动 Windows 本地配音服务。")));
    child.on("close", (code) => code === 0 && fs.existsSync(output) && fs.statSync(output).size > 128 ? resolve({ filename, source: preliminary.source }) : reject(new Error(errors.trim() || "当前 Windows 没有可用的本地语音，请在设置中填写 OpenAI API 后生成配音。")));
  });
}

module.exports = {
  ...comfyui,
  MAX_ENCODED_IMAGE_CHARS,
  MAX_IMAGE_JSON_ENVELOPE_BYTES,
  MAX_MODELS_JSON_BYTES,
  MAX_PROVIDER_IMAGE_BYTES,
  MAX_PROVIDER_SPEECH_BYTES,
  MAX_PROVIDER_VIDEO_BYTES,
  MAX_STORYBOARD_JSON_BYTES,
  MAX_URL_JSON_ENVELOPE_BYTES,
  MAX_VIDEO_TASK_JSON_BYTES,
  ProviderHttpError,
  createDemoSpeech,
  demoSpeechPlan,
  createCharacterProfile,
  createImage,
  analyzeStyleReference,
  optimizeImagePrompt,
  optimizeVideoPrompt,
  createSpeech,
  createStoryboard,
  mediaPathFromUrl,
  pollVideoTask,
  preflightVideoTask,
  publishImageBufferAtomic,
  readBoundedJsonResponse,
  secureMediaFetch,
  streamResponseToMedia,
  submitVideoTask,
  testElevenLabsConnection,
  testSeedanceConnection,
  testConnection,
  validateSeedanceModelId,
  writeMedia,
};
