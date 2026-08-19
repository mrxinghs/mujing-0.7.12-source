const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const SECRET_BYTES = 32;

function normalizeEndpoint(baseUrl) {
  let endpoint;
  try { endpoint = new URL(String(baseUrl || "").trim()); }
  catch { throw new Error("付费服务 Endpoint 无效，已阻止网络请求。请恢复原 Endpoint/账户或先核查任务。"); }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("付费服务 Endpoint 格式不安全，已阻止网络请求。请恢复原 Endpoint/账户或先核查任务。");
  }
  endpoint.protocol = endpoint.protocol.toLowerCase();
  const hostname = endpoint.hostname.toLowerCase();
  endpoint.hostname = hostname.endsWith(".") && !hostname.endsWith("].") ? hostname.slice(0, -1) : hostname;
  const pathname = endpoint.pathname
    .replace(/%[0-9a-f]{2}/gi, (encoded) => {
      const character = String.fromCharCode(Number.parseInt(encoded.slice(1), 16));
      return /[A-Za-z0-9\-._~]/.test(character) ? character : encoded.toUpperCase();
    })
    .replace(/\/+$/, "") || "/";
  return `${endpoint.origin}${pathname}`;
}

function atomicCreateSecret(secretPath, io = fs, randomBytes = crypto.randomBytes) {
  io.mkdirSync(path.dirname(secretPath), { recursive: true });
  const temporaryPath = `${secretPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let descriptor;
  try {
    descriptor = io.openSync(temporaryPath, "wx", 0o600);
    io.writeFileSync(descriptor, randomBytes(SECRET_BYTES));
    io.fsyncSync(descriptor);
    io.closeSync(descriptor);
    descriptor = undefined;
    try { io.chmodSync(temporaryPath, 0o600); } catch { /* Windows may not expose POSIX modes. */ }
    try {
      io.linkSync(temporaryPath, secretPath);
      io.unlinkSync(temporaryPath);
    }
    catch (error) {
      if (!io.existsSync(secretPath) || !["EEXIST", "EPERM", "EACCES"].includes(error?.code)) throw error;
      io.unlinkSync(temporaryPath);
    }
    try { io.chmodSync(secretPath, 0o600); } catch { /* Windows may not expose POSIX modes. */ }
  } catch (error) {
    if (descriptor !== undefined) {
      try { io.closeSync(descriptor); } catch { /* Preserve the original error. */ }
    }
    try { if (io.existsSync(temporaryPath)) io.unlinkSync(temporaryPath); } catch { /* Preserve the original error. */ }
    throw new Error(`付费任务身份 secret 无法安全创建，已阻止网络请求：${error instanceof Error ? error.message : String(error)}`);
  }
}

function createIdentitySecretStore(secretPath, options = {}) {
  const io = options.fs || fs;
  const randomBytes = options.randomBytes || crypto.randomBytes;

  function load({ allowCreate = false } = {}) {
    if (!io.existsSync(secretPath)) {
      if (!allowCreate) throw new Error("付费任务身份 secret 缺失；为避免把旧任务发送到错误 Endpoint/账户，已阻止请求，请先核查任务。");
      atomicCreateSecret(secretPath, io, randomBytes);
    }
    let secret;
    try { secret = io.readFileSync(secretPath); }
    catch (error) { throw new Error(`付费任务身份 secret 无法读取，已阻止网络请求：${error instanceof Error ? error.message : String(error)}`); }
    if (!Buffer.isBuffer(secret) || secret.length !== SECRET_BYTES) {
      throw new Error("付费任务身份 secret 已损坏；为避免误轮询，已阻止请求，请先核查任务。");
    }
    try { io.chmodSync(secretPath, 0o600); } catch { /* Best-effort permission restriction. */ }
    return secret;
  }

  return { load };
}

function hmacFingerprint(secret, domain, value) {
  return crypto.createHmac("sha256", secret).update(`${domain}\0${value}`).digest("hex");
}

function serviceFingerprints(config, secret) {
  const endpoint = normalizeEndpoint(config?.baseUrl);
  const apiKey = String(config?.apiKey || "");
  if (!apiKey.trim()) throw new Error("付费服务账户密钥缺失，已阻止网络请求。请恢复原 Endpoint/账户或先核查任务。");
  return {
    endpointFingerprint: hmacFingerprint(secret, "paid-video-endpoint-v1", endpoint),
    accountFingerprint: hmacFingerprint(secret, "paid-video-account-v1", apiKey),
  };
}

module.exports = { createIdentitySecretStore, normalizeEndpoint, serviceFingerprints };
