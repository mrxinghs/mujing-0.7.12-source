const crypto = require("node:crypto");

const CONTEXT_FIELDS = ["projectId", "shotId", "provider", "endpointFingerprint", "accountFingerprint", "requestFingerprint"];

function stableContext(context) {
  return JSON.stringify(Object.fromEntries(CONTEXT_FIELDS.map((field) => [field, String(context?.[field] || "")])));
}

function createPaidResubmitAuthorizer(options = {}) {
  const now = options.now || Date.now;
  const randomBytes = options.randomBytes || crypto.randomBytes;
  const ttlMs = Math.max(1, Number(options.ttlMs || 90_000));
  const grants = new Map();

  async function request({ senderId, context, confirm, notice }) {
    if (!Number.isInteger(senderId) || senderId < 0) throw new Error("重提授权缺少可信的页面发送者，已阻止操作。");
    if (typeof confirm !== "function" || await confirm(notice) !== true) return { authorized: false };
    const token = randomBytes(32).toString("hex");
    const expiresAt = now() + ttlMs;
    grants.set(token, { senderId, context: stableContext(context), expiresAt });
    return { authorized: true, token, expiresAt };
  }

  function consume({ senderId, token, context }) {
    const normalizedToken = String(token || "");
    const grant = grants.get(normalizedToken);
    if (grant) grants.delete(normalizedToken);
    if (!grant) throw new Error("付费重提授权无效或已使用，已阻止新增 POST。");
    if (grant.expiresAt < now()) throw new Error("付费重提授权已过期，已阻止新增 POST。");
    if (grant.senderId !== senderId || grant.context !== stableContext(context)) {
      throw new Error("付费重提授权与当前页面、镜头、输入、Endpoint 或账户不匹配，已阻止新增 POST。");
    }
  }

  return { consume, request };
}

module.exports = { createPaidResubmitAuthorizer };
