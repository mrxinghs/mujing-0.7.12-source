const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const MAX_LOOPBACK_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_LOOPBACK_RESPONSE_BYTES = 128 * 1024 * 1024;

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".ogg": "audio/ogg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".wav": "audio/wav",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

class LoopbackHttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function methodNeedsBody(method) {
  return !["GET", "HEAD"].includes(String(method || "GET").toUpperCase());
}

function declaredContentLength(headers, label) {
  const raw = headers?.["content-length"] ?? headers?.get?.("content-length");
  if (raw === undefined || raw === null || raw === "") return null;
  const value = Number(raw);
  if (!/^\d+$/.test(String(raw)) || !Number.isSafeInteger(value) || value < 0) throw new LoopbackHttpError(400, `${label} Content-Length 无效`);
  return value;
}

function requestBody(request, options = {}) {
  const maxBytes = options.maxBytes ?? MAX_LOOPBACK_REQUEST_BYTES;
  const concat = options.concat || Buffer.concat;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;
    let declaredLength;
    const cleanup = () => {
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.removeListener("error", onError);
      request.removeListener("aborted", onAborted);
    };
    const fail = (error, drain = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      chunks.length = 0;
      if (drain) request.resume?.();
      reject(error);
    };
    const onData = (chunk) => {
      const view = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (totalBytes + view.length > maxBytes) {
        fail(new LoopbackHttpError(413, `loopback 请求体超过安全上限 ${maxBytes} 字节`), true);
        return;
      }
      chunks.push(view);
      totalBytes += view.length;
    };
    const onEnd = () => {
      if (settled) return;
      if (declaredLength !== null && totalBytes !== declaredLength) {
        fail(new LoopbackHttpError(400, "loopback 请求传输中断：实际字节数与 Content-Length 不一致"));
        return;
      }
      settled = true;
      cleanup();
      resolve(totalBytes ? concat(chunks, totalBytes) : undefined);
    };
    const onError = (error) => fail(error);
    const onAborted = () => fail(new Error("loopback 请求传输中断（aborted）"));
    try {
      if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("loopback 请求缺少有效大小上限");
      declaredLength = declaredContentLength(request.headers, "loopback 请求");
      if (declaredLength !== null && declaredLength > maxBytes) {
        fail(new LoopbackHttpError(413, `loopback 请求 Content-Length 超过安全上限 ${maxBytes} 字节`), true);
        return;
      }
      request.on("data", onData);
      request.once("end", onEnd);
      request.once("error", onError);
      request.once("aborted", onAborted);
    } catch (error) { fail(error, error?.statusCode === 413); }
  });
}

function waitForDrain(response) {
  return new Promise((resolve, reject) => {
    if (response.destroyed || response.writableEnded) {
      reject(new Error("loopback 响应连接已中断"));
      return;
    }
    const cleanup = () => {
      response.removeListener("drain", onDrain);
      response.removeListener("error", onError);
      response.removeListener("close", onClose);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onError = (error) => { cleanup(); reject(error); };
    const onClose = () => { cleanup(); reject(new Error("loopback 响应连接已中断")); };
    response.once("drain", onDrain);
    response.once("error", onError);
    response.once("close", onClose);
  });
}

function readWorkerChunk(reader, response) {
  if (response.destroyed || response.writableEnded) return Promise.reject(new Error("loopback 响应连接已中断"));
  return new Promise((resolve, reject) => {
    const cleanup = () => response.removeListener("close", onClose);
    const onClose = () => { cleanup(); reject(new Error("loopback 响应连接已中断")); };
    response.once("close", onClose);
    Promise.resolve(reader.read()).then(
      (packet) => { cleanup(); resolve(packet); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

async function sendWorkerResponse(webResponse, response, options = {}) {
  const maxBytes = options.maxBytes ?? MAX_LOOPBACK_RESPONSE_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("loopback 响应缺少有效大小上限");
  const reader = webResponse?.body?.getReader?.();
  let totalBytes = 0;
  try {
    const declaredLength = declaredContentLength(webResponse.headers, "loopback 响应");
    if (declaredLength !== null && declaredLength > maxBytes) throw new LoopbackHttpError(502, `loopback 响应 Content-Length 超过安全上限 ${maxBytes} 字节`);
    response.statusCode = webResponse.status;
    webResponse.headers?.forEach?.((value, key) => response.setHeader(key, value));
    if (!reader) {
      response.end();
      return;
    }
    while (true) {
      const packet = await readWorkerChunk(reader, response);
      if (packet.done) break;
      if (!(packet.value instanceof Uint8Array) || packet.value.byteLength === 0) continue;
      if (totalBytes + packet.value.byteLength > maxBytes) throw new LoopbackHttpError(502, `loopback 响应超过安全上限 ${maxBytes} 字节`);
      totalBytes += packet.value.byteLength;
      const view = Buffer.from(packet.value.buffer, packet.value.byteOffset, packet.value.byteLength);
      if (!response.write(view)) await waitForDrain(response);
    }
    if (declaredLength !== null && totalBytes !== declaredLength) throw new Error("loopback worker 响应传输中断：实际字节数与 Content-Length 不一致");
    response.end();
  } catch (error) {
    try { await reader?.cancel?.(); } catch { /* Cleanup continues. */ }
    if (response.headersSent && !response.writableEnded && !response.destroyed) response.destroy(error);
    throw error;
  } finally {
    try { reader?.releaseLock?.(); } catch { /* Cleanup continues. */ }
  }
}

function safeStaticPath(clientDir, pathname) {
  const decoded = decodeURIComponent(pathname);
  const resolved = path.resolve(clientDir, `.${decoded}`);
  const normalizedRoot = `${path.resolve(clientDir)}${path.sep}`.toLowerCase();
  return resolved.toLowerCase().startsWith(normalizedRoot) ? resolved : null;
}

async function startLocalServer(appRoot, mediaDir) {
  const clientDir = path.join(appRoot, "dist", "client");
  const serverEntry = path.join(appRoot, "dist", "server", "index.js");

  if (!fs.existsSync(clientDir) || !fs.existsSync(serverEntry)) {
    throw new Error("桌面应用资源不完整，请重新安装幕境。");
  }

  const workerModule = await import(pathToFileURL(serverEntry).href);
  const worker = workerModule.default;

  const server = http.createServer(async (request, response) => {
    try {
      const origin = `http://127.0.0.1:${server.address().port}`;
      const requestUrl = new URL(request.url || "/", origin);
      if (request.method === "GET" && requestUrl.pathname.startsWith("/__media/")) {
        const name = path.basename(decodeURIComponent(requestUrl.pathname.slice("/__media/".length)));
        const mediaPath = path.resolve(mediaDir, name);
        const mediaRoot = `${path.resolve(mediaDir)}${path.sep}`.toLowerCase();
        if (mediaPath.toLowerCase().startsWith(mediaRoot) && fs.existsSync(mediaPath) && fs.statSync(mediaPath).isFile()) {
          const size = fs.statSync(mediaPath).size;
          const range = request.headers.range?.match(/bytes=(\d+)-(\d*)/);
          response.setHeader("Content-Type", mimeTypes[path.extname(mediaPath).toLowerCase()] || "application/octet-stream");
          response.setHeader("Accept-Ranges", "bytes");
          response.setHeader("Cache-Control", "no-cache");
          if (range) {
            const start = Number(range[1]);
            const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
            if (start >= size || end < start) {
              response.statusCode = 416;
              response.setHeader("Content-Range", `bytes */${size}`);
              response.end();
              return;
            }
            response.statusCode = 206;
            response.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
            response.setHeader("Content-Length", end - start + 1);
            fs.createReadStream(mediaPath, { start, end }).pipe(response);
          } else {
            response.statusCode = 200;
            response.setHeader("Content-Length", size);
            fs.createReadStream(mediaPath).pipe(response);
          }
          return;
        }
      }
      const staticPath = safeStaticPath(clientDir, requestUrl.pathname);

      if (request.method === "GET" && staticPath && fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) {
        response.statusCode = 200;
        response.setHeader("Content-Type", mimeTypes[path.extname(staticPath).toLowerCase()] || "application/octet-stream");
        response.setHeader("Cache-Control", requestUrl.pathname.startsWith("/_next/static/") ? "public, max-age=31536000, immutable" : "no-cache");
        fs.createReadStream(staticPath).pipe(response);
        return;
      }

      const body = methodNeedsBody(request.method) ? await requestBody(request) : undefined;
      const webRequest = new Request(requestUrl, {
        method: request.method,
        headers: request.headers,
        body,
      });
      const pending = [];
      const webResponse = await worker.fetch(webRequest, {}, {
        waitUntil(promise) { pending.push(Promise.resolve(promise)); },
        passThroughOnException() {},
      });

      await sendWorkerResponse(webResponse, response);
      void Promise.allSettled(pending);
    } catch (error) {
      if (!response.headersSent && !response.writableEnded) {
        response.statusCode = error?.statusCode || 500;
        response.setHeader("Content-Type", "text/plain; charset=utf-8");
        response.end(`幕境启动失败：${error instanceof Error ? error.message : String(error)}`);
      } else if (!response.writableEnded && !response.destroyed) response.destroy(error);
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  return {
    server,
    url: `http://127.0.0.1:${address.port}/`,
  };
}

module.exports = {
  MAX_LOOPBACK_REQUEST_BYTES,
  MAX_LOOPBACK_RESPONSE_BYTES,
  methodNeedsBody,
  requestBody,
  sendWorkerResponse,
  startLocalServer,
};
