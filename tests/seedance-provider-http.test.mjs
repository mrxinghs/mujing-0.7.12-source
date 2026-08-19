import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { VALID_PNG } from "./image-fixtures.mjs";

const require = createRequire(import.meta.url);
const providers = require("../desktop/providers.cjs");
const { createPaidTaskJournal, createPaidTaskManager } = require("../desktop/paid-task-journal.cjs");

const config = {
  apiKey: "TOP_SECRET_API_KEY",
  baseUrl: "https://example.invalid/api/v3",
  videoModel: "ep-20260816-seedance25",
};

function paidPayload(overrides = {}) {
  return {
    projectId: "seedance-contract-project",
    shotId: "shot-01",
    provider: "Seedance",
    prompt: "A clean prompt containing PRIVATE_PROMPT_TEXT",
    ratio: "9:16",
    duration: 12,
    imageUrl: `data:image/png;base64,${VALID_PNG.toString("base64")}`,
    ...overrides,
  };
}

function providerPayload(overrides = {}) {
  const payload = paidPayload(overrides);
  delete payload.imageUrl;
  payload.firstFrameInput = {
    buffer: VALID_PNG,
    digest: crypto.createHash("sha256").update(VALID_PNG).digest("hex"),
    mimeType: "image/png",
  };
  return payload;
}

async function withJournal(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mujing-seedance-http-"));
  const journalPath = path.join(directory, "paid-video-tasks.json");
  try { await run({ directory, journalPath }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

function managerFor(journalPath) {
  const journal = createPaidTaskJournal(journalPath, { identitySecret: Buffer.alloc(32, 0x61) });
  return {
    journal,
    manager: createPaidTaskManager({
      journal,
      preflightTask: providers.preflightVideoTask,
      submitTask: (providerConfig, payload) => providers.submitVideoTask(providerConfig, payload),
      pollTask: async () => ({ status: "running" }),
    }),
  };
}

test("an account-enabled Seedance 2.5 model id is allowed and durably submitted", async () => {
  await withJournal(async ({ journalPath }) => {
    let posts = 0;
    const originalFetch = global.fetch;
    global.fetch = async () => { posts += 1; return new Response(JSON.stringify({ id: "seedance-25-task", status: "queued" }), { status: 200 }); };
    try {
      const { journal, manager } = managerFor(journalPath);
      const enabledConfig = { ...config, baseUrl: "https://ark.cn-beijing.volces.com/api/v3", videoModel: "doubao-seedance-2-5-260628" };
      const result = await manager.submit(enabledConfig, paidPayload({ imageRole: "reference_image", resolution: "720p" }), "C:\\unused");
      assert.equal(result.jobId, "seedance-25-task");
      assert.equal(posts, 1);
      assert.equal(journal.list(paidPayload().projectId)[0].taskId, "seedance-25-task");
    } finally { global.fetch = originalFetch; }
  });
});

test("Seedance 2.x submits a reference image with official structured generation parameters", async () => {
  const requests = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ id: "official-top-level-id", status: "queued", data: { id: "nested-decoy" } }), { status: 200 });
  };
  try {
    const result = await providers.submitVideoTask(config, providerPayload());
    assert.deepEqual(result, { jobId: "official-top-level-id", status: "queued" });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://example.invalid/api/v3/contents/generations/tasks");
    assert.equal(requests[0].body.model, "ep-20260816-seedance25");
    assert.deepEqual(requests[0].body.content[0], { type: "text", text: "A clean prompt containing PRIVATE_PROMPT_TEXT" });
    assert.equal(requests[0].body.content[1].type, "image_url");
    assert.equal(requests[0].body.content[1].role, "reference_image");
    assert.equal(requests[0].body.ratio, "9:16");
    assert.equal(requests[0].body.duration, 12);
    assert.equal(requests[0].body.resolution, "720p");
    assert.equal(requests[0].body.generate_audio, false);
    assert.equal(Object.hasOwn(requests[0].body, "watermark"), false);
  } finally { global.fetch = originalFetch; }
});

test("Seedance blocks a first frame whose real dimensions do not match the project ratio before POST", async () => {
  let posts = 0;
  const originalFetch = global.fetch;
  global.fetch = async () => { posts += 1; return new Response("{}", { status: 200 }); };
  try {
    const mismatch = providerPayload({ ratio: "16:9" });
    mismatch.enforceAspect = true;
    mismatch.firstFrameInput = { ...mismatch.firstFrameInput, width: 720, height: 1280 };
    await assert.rejects(providers.submitVideoTask(config, mismatch), /首图比例与项目不一致/);
    assert.equal(posts, 0);
  } finally { global.fetch = originalFetch; }
});

test("Seedance 2.x keeps strict-first-frame available when the user selects it", async () => {
  const requests = [];
  const originalFetch = global.fetch;
  global.fetch = async (_url, init = {}) => {
    requests.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ id: "strict-first-frame-task", status: "queued" }), { status: 200 });
  };
  try {
    await providers.submitVideoTask(config, providerPayload({ imageRole: "first_frame" }));
    assert.equal(requests[0].content[1].role, "first_frame");
  } finally { global.fetch = originalFetch; }
});

test("Seedance 1.0 requires strict-first-frame mode and uses structured parameters", async () => {
  const requests = [];
  const originalFetch = global.fetch;
  global.fetch = async (_url, init = {}) => {
    requests.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ id: "legacy-task-id", status: "queued" }), { status: 200 });
  };
  try {
    const legacyConfig = { ...config, videoModel: "doubao-seedance-1-0-pro-250528" };
    const result = await providers.submitVideoTask(legacyConfig, providerPayload({ duration: 5, imageRole: "first_frame" }));
    assert.equal(result.jobId, "legacy-task-id");
    assert.equal(requests[0].ratio, "9:16");
    assert.equal(requests[0].duration, 5);
    assert.equal(requests[0].resolution, "720p");
    assert.equal(requests[0].content[1].role, "first_frame");
  } finally { global.fetch = originalFetch; }
});

test("Seedance submission accepts only the official top-level id", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({ status: "queued", data: { id: "nested-id-must-not-count" } }), { status: 200 });
  try {
    await assert.rejects(providers.submitVideoTask(config, providerPayload()), /任务 ID/);
  } finally { global.fetch = originalFetch; }
});

test("non-2xx provider responses throw a structured, secret-free ProviderHttpError", async () => {
  const originalFetch = global.fetch;
  const leakedBase64 = "data:image/png;base64,LEAKED_BASE64_BODY";
  global.fetch = async () => new Response(JSON.stringify({
    error: { code: "InvalidParameter.UnsupportedModel", message: `PRIVATE_PROMPT_TEXT TOP_SECRET_API_KEY ${leakedBase64}` },
    request_id: "provider-body-request-id",
    request_body: paidPayload(),
  }), { status: 429, headers: { "x-request-id": "safe-request-id-123" } });
  try {
    await assert.rejects(providers.submitVideoTask(config, providerPayload()), (error) => {
      assert.ok(error instanceof providers.ProviderHttpError);
      assert.equal(error.name, "ProviderHttpError");
      assert.equal(error.code, "PROVIDER_HTTP_REJECTED");
      assert.equal(error.status, 429);
      assert.equal(error.providerCode, "InvalidParameter.UnsupportedModel");
      assert.equal(error.requestId, "safe-request-id-123");
      assert.equal(error.definitiveRejection, true);
      assert.match(error.message, /HTTP 429/);
      assert.doesNotMatch(JSON.stringify(error), /PRIVATE_PROMPT_TEXT|TOP_SECRET_API_KEY|LEAKED_BASE64_BODY|request_body/);
      assert.doesNotMatch(error.stack || "", /PRIVATE_PROMPT_TEXT|TOP_SECRET_API_KEY|LEAKED_BASE64_BODY|request_body/);
      return true;
    });
  } finally { global.fetch = originalFetch; }
});

test("Seedance privacy rejections explain the authorized trusted-material route", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({
    error: {
      code: "InputImageSensitiveContentDetected.PrivacyInformation",
      message: "RAW PRIVATE MESSAGE",
    },
  }), { status: 400, headers: { "x-request-id": "privacy-request-id" } });
  try {
    await assert.rejects(providers.submitVideoTask(config, providerPayload()), (error) => {
      assert.ok(error instanceof providers.ProviderHttpError);
      assert.equal(error.code, "PROVIDER_PRIVACY_REFERENCE_REJECTED");
      assert.equal(error.privacyReferenceRejected, true);
      assert.match(error.message, /真人或隐私信息审核/);
      assert.match(error.message, /同一张图反复重试仍会失败/);
      assert.match(error.message, /真人像库\/可信素材库/);
      assert.match(error.message, /asset:\/\//);
      assert.doesNotMatch(error.message, /RAW PRIVATE MESSAGE/);
      return true;
    });
  } finally { global.fetch = originalFetch; }
});

test("a 2xx failed task never forwards the provider response message to the renderer", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({
    id: "known-task-id",
    status: "failed",
    error: { message: "PRIVATE_PROMPT_TEXT TOP_SECRET_API_KEY data:image/png;base64,LEAKED_BASE64_BODY" },
  }), { status: 200 });
  try {
    const result = await providers.pollVideoTask(config, { provider: "Seedance", jobId: "known-task-id" }, "C:\\unused");
    assert.equal(result.status, "failed");
    assert.match(result.error, /Seedance 视频生成失败/);
    assert.doesNotMatch(result.error, /PRIVATE_PROMPT_TEXT|TOP_SECRET_API_KEY|LEAKED_BASE64_BODY|base64/);
  } finally { global.fetch = originalFetch; }
});

test("HTTP rejection is durably rejected, never unknown, and an ordinary retry is allowed", async () => {
  await withJournal(async ({ journalPath }) => {
    let postCount = 0;
    const originalFetch = global.fetch;
    global.fetch = async () => {
      postCount += 1;
      if (postCount === 1) return new Response(JSON.stringify({ error: { code: "InvalidEndpointOrModel.NotFound", message: "PRIVATE_PROMPT_TEXT TOP_SECRET_API_KEY" }, request_id: "journal-request-id" }), { status: 400 });
      return new Response(JSON.stringify({ id: "retry-task-id", status: "queued" }), { status: 200 });
    };
    try {
      const { journal, manager } = managerFor(journalPath);
      await assert.rejects(manager.submit(config, paidPayload(), "C:\\unused"), (error) => error instanceof providers.ProviderHttpError);
      const rejected = journal.list(paidPayload().projectId);
      assert.equal(rejected.length, 1);
      assert.equal(rejected[0].status, "rejected");
      assert.equal(rejected[0].failure, "provider-http-rejected");
      assert.equal(rejected[0].httpStatus, 400);
      assert.equal(rejected[0].providerCode, "InvalidEndpointOrModel.NotFound");
      assert.equal(rejected[0].requestId, "journal-request-id");
      assert.equal(rejected[0].taskId, null);
      assert.doesNotMatch(await readFile(journalPath, "utf8"), /PRIVATE_PROMPT_TEXT|TOP_SECRET_API_KEY|LEAKED_BASE64_BODY|request_body/);

      const retried = await manager.submit(config, paidPayload(), "C:\\unused");
      assert.equal(retried.jobId, "retry-task-id");
      assert.equal(postCount, 2);
    } finally { global.fetch = originalFetch; }
  });
});

test("transport loss and a 2xx response without top-level id remain unknown and gated", async () => {
  for (const scenario of ["transport", "missing-id"]) {
    await withJournal(async ({ journalPath }) => {
      let postCount = 0;
      const originalFetch = global.fetch;
      global.fetch = async () => {
        postCount += 1;
        if (scenario === "transport") throw new Error("socket lost after POST");
        return new Response(JSON.stringify({ status: "queued", data: { id: "nested-is-not-official" } }), { status: 200 });
      };
      try {
        const { journal, manager } = managerFor(journalPath);
        await assert.rejects(manager.submit(config, paidPayload(), "C:\\unused"), /可能已受理|任务 ID/);
        assert.equal(journal.list(paidPayload().projectId)[0].status, "unknown");
        await assert.rejects(manager.submit(config, paidPayload(), "C:\\unused"), /阻止自动再次提交|可能已受理/);
        assert.equal(postCount, 1);
      } finally { global.fetch = originalFetch; }
    });
  }
});

test("a prior unknown attempt is retained when an authorized later attempt is HTTP-rejected", async () => {
  await withJournal(async ({ journalPath }) => {
    const { createPaidResubmitAuthorizer } = require("../desktop/paid-resubmit-authorization.cjs");
    const journal = createPaidTaskJournal(journalPath, { identitySecret: Buffer.alloc(32, 0x61) });
    const authorizer = createPaidResubmitAuthorizer();
    let attempt = 0;
    const manager = createPaidTaskManager({
      journal,
      resubmitAuthorizer: authorizer,
      submitTask: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("transport lost");
        throw new providers.ProviderHttpError(403);
      },
      pollTask: async () => ({ status: "running" }),
    });
    await assert.rejects(manager.submit(config, paidPayload(), "C:\\unused"), /可能已受理/);
    const grant = await manager.requestResubmitAuthorization(config, paidPayload(), "C:\\unused", { senderId: 9, confirm: async () => true });
    await assert.rejects(manager.resubmit(config, paidPayload(), "C:\\unused", { senderId: 9, token: grant.token }), (error) => error instanceof providers.ProviderHttpError);
    assert.deepEqual(journal.list(paidPayload().projectId).map((entry) => entry.status).sort(), ["rejected", "unknown"]);
  });
});

test("renderer distinguishes definitive rejection from unknown acceptance risk", async () => {
  const safety = await import(`../app/workflow-safety.mjs?seedance-http=${Date.now()}`);
  assert.equal(safety.paidSubmissionRiskFromError("服务商拒绝了请求（HTTP 400），请检查设置后重试。"), false);
  assert.equal(safety.paidSubmissionRiskFromError("服务商可能已受理上一次付费请求，但没有可靠任务 ID。"), true);

  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /entry\.status === "rejected"/);
  assert.match(page, /paidSubmissionRiskFromError/);
  assert.doesNotMatch(page, /videoSubmissionRisk:\s*!replacementJobId/);
});
