import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { VALID_PNG, VALID_PNG_ALT } from "./image-fixtures.mjs";

const require = createRequire(import.meta.url);
const providers = require("../desktop/providers.cjs");
const VALID_REFERENCE = VALID_PNG.toString("base64");

async function withJournal(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mujing-paid-task-"));
  const journalPath = path.join(directory, "paid-video-tasks.json");
  try { await run({ directory, journalPath }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

function loadPaidTaskModule() {
  return require("../desktop/paid-task-journal.cjs");
}

function payload(overrides = {}) {
  return {
    projectId: "project-0.3.4-test",
    shotId: "shot-01",
    provider: "Seedance",
    prompt: "SECRET PROMPT must never enter the journal",
    ratio: "16:9",
    duration: 4,
    imageUrl: `data:image/png;base64,${VALID_REFERENCE}`,
    ...overrides,
  };
}

const config = { apiKey: "SECRET_API_KEY", baseUrl: "https://example.invalid/v1", videoModel: "video-test" };

function managerFor(journalPath) {
  const { createPaidTaskJournal, createPaidTaskManager } = loadPaidTaskModule();
  const { createPaidResubmitAuthorizer } = require("../desktop/paid-resubmit-authorization.cjs");
  const journal = createPaidTaskJournal(journalPath);
  return {
    journal,
    manager: createPaidTaskManager({
      journal,
      resubmitAuthorizer: createPaidResubmitAuthorizer(),
      submitTask: (providerConfig, request, mediaDir) => providers.submitVideoTask(providerConfig, request, mediaDir),
      pollTask: (providerConfig, request, mediaDir) => providers.pollVideoTask(providerConfig, request, mediaDir),
    }),
  };
}

async function authorizeResubmit(manager, nextPayload = payload(), mediaDir = "C:\\unused", senderId = 1) {
  const grant = await manager.requestResubmitAuthorization(config, nextPayload, mediaDir, { senderId, confirm: async () => true });
  assert.equal(grant.authorized, true);
  return { senderId, token: grant.token };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

test("paid task id is durable before renderer receives it and an ordinary retry performs zero new POSTs", async () => {
  await withJournal(async ({ journalPath }) => {
    let postCount = 0;
    const originalFetch = global.fetch;
    global.fetch = async (_url, init = {}) => {
      if (init.method === "POST") postCount += 1;
      return new Response(JSON.stringify({ id: "paid-task-durable", status: "queued" }), { status: 200 });
    };
    try {
      const first = managerFor(journalPath).manager;
      assert.deepEqual(await first.submit(config, payload(), "C:\\unused"), { jobId: "paid-task-durable", status: "queued", recovered: false });
      const onDisk = await readFile(journalPath, "utf8");
      assert.match(onDisk, /paid-task-durable/);
      assert.doesNotMatch(onDisk, /SECRET PROMPT|SECRET_API_KEY|SECRET_REFERENCE/);

      const afterRestart = managerFor(journalPath).manager;
      assert.deepEqual(await afterRestart.submit(config, payload(), "C:\\unused"), { jobId: "paid-task-durable", status: "queued", recovered: true });
      assert.equal(postCount, 1);
    } finally { global.fetch = originalFetch; }
  });
});

test("explicit local abandon preserves the old task audit but unlocks a later changed request", async () => {
  await withJournal(async ({ journalPath }) => {
    const { createPaidTaskJournal, createPaidTaskManager } = loadPaidTaskModule();
    const journal = createPaidTaskJournal(journalPath, { identitySecret: Buffer.alloc(32, 0x44) });
    let submitCount = 0;
    let pollCount = 0;
    const manager = createPaidTaskManager({
      journal,
      submitTask: async () => ({ jobId: `remote-task-${++submitCount}`, status: "queued" }),
      pollTask: async () => { pollCount += 1; return { status: "running" }; },
    });
    const first = await manager.submit(config, payload(), "C:\\unused");
    assert.equal(first.jobId, "remote-task-1");

    const abandoned = manager.abandon({ projectId: payload().projectId, shotId: payload().shotId });
    assert.deepEqual(abandoned, { abandoned: true, count: 1, remoteMayContinue: true });
    const audit = manager.list(payload().projectId);
    assert.equal(audit[0].status, "abandoned");
    assert.equal(audit[0].taskId, "remote-task-1");
    assert.ok(audit[0].abandonedAt);
    await assert.rejects(manager.poll(config, { ...payload(), jobId: "remote-task-1" }, "C:\\unused"), /已由你放弃/);
    assert.equal(pollCount, 0);

    const second = await manager.submit(config, payload({ prompt: "a deliberately changed shot after explicit abandon" }), "C:\\unused");
    assert.equal(second.jobId, "remote-task-2");
    assert.equal(submitCount, 2);
    assert.equal(manager.list(payload().projectId).some((entry) => entry.status === "abandoned" && entry.taskId === "remote-task-1"), true);
  });
});

test("response loss, missing id, and a crash-window pending intent all fail closed", async () => {
  for (const scenario of ["response-loss", "missing-id", "pending-before-post"]) {
    await withJournal(async ({ journalPath }) => {
      let postCount = 0;
      const originalFetch = global.fetch;
      global.fetch = async (_url, init = {}) => {
        if (init.method === "POST") postCount += 1;
        if (scenario === "response-loss") throw new Error("socket vanished after request bytes were sent");
        return new Response(JSON.stringify({ status: "queued" }), { status: 200 });
      };
      try {
        const { journal, manager } = managerFor(journalPath);
        if (scenario === "pending-before-post") journal.recordSubmissionIntent(payload(), config);
        else await assert.rejects(manager.submit(config, payload(), "C:\\unused"), /可能已受理|任务 ID/);

        await assert.rejects(managerFor(journalPath).manager.submit(config, payload(), "C:\\unused"), /可能已受理|阻止自动再次提交/);
        assert.equal(postCount, scenario === "pending-before-post" ? 0 : 1, `${scenario} must not issue a second paid POST`);
        assert.doesNotMatch(await readFile(journalPath, "utf8"), /SECRET PROMPT|SECRET_API_KEY|SECRET_REFERENCE/);
      } finally { global.fetch = originalFetch; }
    });
  }
});

test("an atomic journal replacement failure blocks the paid POST and removes its temporary file", async () => {
  await withJournal(async ({ directory, journalPath }) => {
    const { createPaidTaskJournal, createPaidTaskManager } = loadPaidTaskModule();
    let submitCount = 0;
    const failingFs = new Proxy(fs, {
      get(target, property, receiver) {
        if (property === "renameSync") return () => { const error = new Error("simulated replace failure"); error.code = "EIO"; throw error; };
        return Reflect.get(target, property, receiver);
      },
    });
    const manager = createPaidTaskManager({
      journal: createPaidTaskJournal(journalPath, { fs: failingFs, identitySecret: Buffer.alloc(32, 0x33) }),
      submitTask: async () => { submitCount += 1; return { jobId: "must-not-exist" }; },
      pollTask: async () => ({ status: "running" }),
    });
    await assert.rejects(manager.submit(config, payload(), directory), /无法原子保存/);
    assert.equal(submitCount, 0);
    assert.deepEqual(fs.readdirSync(directory).filter((name) => name.endsWith(".tmp")), []);
  });
});

test("ordinary submit flags cannot bypass recovery; only a native-authorized resubmit path adds a POST", async () => {
  await withJournal(async ({ journalPath }) => {
    let postCount = 0;
    const originalFetch = global.fetch;
    global.fetch = async () => {
      postCount += 1;
      return new Response(JSON.stringify({ id: `paid-task-${postCount}`, status: "queued" }), { status: 200 });
    };
    try {
      const manager = managerFor(journalPath).manager;
      const first = await manager.submit(config, payload(), "C:\\unused");
      const recovered = await manager.submit(config, payload({ explicitResubmit: true, abandonOldTask: true }), "C:\\unused");
      assert.equal(recovered.jobId, first.jobId);
      assert.equal(postCount, 1);

      await assert.rejects(manager.resubmit(config, payload(), "C:\\unused", { confirmations: { abandonOldRecord: true, additionalCharge: true } }), /授权|token/i);
      assert.equal(postCount, 1);
      const authorization = await authorizeResubmit(manager);
      const replacement = await manager.resubmit(config, payload(), "C:\\unused", authorization);
      assert.equal(replacement.jobId, "paid-task-2");
      assert.equal(postCount, 2);
    } finally { global.fetch = originalFetch; }
  });
});

test("a task id without a provider fails closed with zero GETs and zero POSTs", async () => {
  await withJournal(async ({ journalPath }) => {
    let getCount = 0;
    let postCount = 0;
    const { createPaidTaskJournal, createPaidTaskManager } = loadPaidTaskModule();
    const manager = createPaidTaskManager({
      journal: createPaidTaskJournal(journalPath),
      submitTask: async () => { postCount += 1; return { jobId: "unexpected" }; },
      pollTask: async () => { getCount += 1; return { status: "running" }; },
    });
    await assert.rejects(
      manager.poll(config, { projectId: "legacy-project", shotId: "shot-01", jobId: "legacy-task" }, "C:\\unused"),
      /未与.*绑定|旧项目缺少原服务商，无法安全轮询/,
    );
    assert.equal(getCount, 0);
    assert.equal(postCount, 0);
  });
});

test("journal provider overrides the current UI provider and only polls the original provider", async () => {
  await withJournal(async ({ journalPath }) => {
    const calls = [];
    const { createPaidTaskJournal, createPaidTaskManager } = loadPaidTaskModule();
    const journal = createPaidTaskJournal(journalPath);
    const { identity } = journal.recordSubmissionIntent(payload(), config);
    journal.recordTaskId(identity, { jobId: "original-task", status: "running" });
    const manager = createPaidTaskManager({
      journal,
      submitTask: async () => { calls.push({ method: "POST" }); return { jobId: "unexpected" }; },
      pollTask: async (_providerConfig, request) => {
        calls.push({ method: "GET", provider: request.provider, jobId: request.jobId });
        return { jobId: request.jobId, status: "running" };
      },
    });
    const result = await manager.poll(config, {
      projectId: payload().projectId,
      shotId: payload().shotId,
      jobId: "original-task",
      provider: "OpenAI Video",
    }, "C:\\unused");
    assert.equal(result.status, "running");
    assert.deepEqual(calls, [{ method: "GET", provider: "Seedance", jobId: "original-task" }]);
  });
});

test("poll rejects renderer task/provider pairs that are not durably bound in the journal", async () => {
  for (const scenario of ["empty-journal", "different-task-id"]) {
    await withJournal(async ({ journalPath }) => {
      let getCount = 0;
      let postCount = 0;
      const originalFetch = global.fetch;
      global.fetch = async (_url, init = {}) => {
        if (init.method === "GET") getCount += 1;
        if (init.method === "POST") postCount += 1;
        return new Response(JSON.stringify({ id: "unexpected", status: "running" }), { status: 200 });
      };
      try {
        const { journal, manager } = managerFor(journalPath);
        if (scenario === "different-task-id") {
          const { identity } = journal.recordSubmissionIntent(payload(), config);
          journal.recordTaskId(identity, { jobId: "journal-task", status: "running" });
        }

        await assert.rejects(
          manager.poll(config, payload({ jobId: "orphan-task", provider: "OpenAI Video" }), "C:\\unused"),
          /未绑定|任务 ID 不匹配|已阻止轮询/,
        );
        assert.equal(getCount, 0, `${scenario} must not issue a GET`);
        assert.equal(postCount, 0, `${scenario} must not issue a POST`);
      } finally { global.fetch = originalFetch; }
    });
  }
});

test("ordinary submit recovers only a fully matching request fingerprint and blocks every paid input change", async () => {
  const changes = [
    { name: "prompt", nextPayload: payload({ prompt: "changed prompt" }), nextConfig: config },
    { name: "ratio", nextPayload: payload({ ratio: "9:16" }), nextConfig: config },
    { name: "duration", nextPayload: payload({ duration: 9 }), nextConfig: config },
    { name: "imageRole", nextPayload: payload({ imageRole: "first_frame" }), nextConfig: config },
    { name: "resolution", nextPayload: payload({ resolution: "480p" }), nextConfig: config },
    { name: "generateAudio", nextPayload: payload({ generateAudio: true }), nextConfig: config },
    { name: "imageUrl", nextPayload: payload({ imageUrl: `data:image/png;base64,${VALID_PNG_ALT.toString("base64")}` }), nextConfig: config },
    { name: "model", nextPayload: payload(), nextConfig: { ...config, videoModel: "video-changed" } },
    { name: "provider", nextPayload: payload({ provider: "OpenAI Video" }), nextConfig: config },
  ];

  for (const change of changes) {
    await withJournal(async ({ journalPath }) => {
      let postCount = 0;
      const originalFetch = global.fetch;
      global.fetch = async (_url, init = {}) => {
        if (init.method === "POST") postCount += 1;
        return new Response(JSON.stringify({ id: `original-${change.name}`, status: "queued" }), { status: 200 });
      };
      try {
        const manager = managerFor(journalPath).manager;
        const first = await manager.submit(config, payload(), "C:\\unused");
        const recovered = await manager.submit(config, payload(), "C:\\unused");
        assert.equal(recovered.jobId, first.jobId);
        assert.equal(recovered.recovered, true);

        await assert.rejects(
          manager.submit(change.nextConfig, change.nextPayload, "C:\\unused"),
          /输入已改变|恢复旧任务|放弃.*重提/,
          `${change.name} must fail closed`,
        );
        assert.equal(postCount, 1, `${change.name} must neither recover the old ID nor create a new paid POST`);
      } finally { global.fetch = originalFetch; }
    });
  }
});

test("concurrent reuse of one explicit-resubmit token permits only one paid POST and one durable task id", async () => {
  await withJournal(async ({ journalPath }) => {
    let postCount = 0;
    const resubmitStarted = deferred();
    const releaseResubmit = deferred();
    const originalFetch = global.fetch;
    global.fetch = async (_url, init = {}) => {
      if (init.method !== "POST") return new Response(JSON.stringify({ status: "running" }), { status: 200 });
      postCount += 1;
      if (postCount === 1) return new Response(JSON.stringify({ id: "original-task", status: "queued" }), { status: 200 });
      resubmitStarted.resolve();
      await releaseResubmit.promise;
      return new Response(JSON.stringify({ id: `replacement-${postCount}`, status: "queued" }), { status: 200 });
    };
    try {
      const { journal, manager } = managerFor(journalPath);
      await manager.submit(config, payload(), "C:\\unused");
      const authorization = await authorizeResubmit(manager);
      const first = manager.resubmit(config, payload(), "C:\\unused", authorization);
      await resubmitStarted.promise;
      const second = manager.resubmit(config, payload(), "C:\\unused", authorization);
      const third = manager.resubmit(config, payload(), "C:\\unused", authorization);
      releaseResubmit.resolve();

      const attempts = await Promise.allSettled([first, second, third]);
      assert.equal(postCount, 2, "the original submit plus exactly one replacement POST are allowed");
      assert.equal(attempts.filter((item) => item.status === "fulfilled").length, 1);
      assert.equal(attempts.filter((item) => item.status === "rejected").length, 2);
      assert.equal(attempts.find((item) => item.status === "fulfilled").value.jobId, "replacement-2");
      const entries = journal.list(payload().projectId);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].taskId, "replacement-2");
      assert.deepEqual(entries[0].previousTaskIds, ["original-task"]);
    } finally {
      releaseResubmit.resolve();
      global.fetch = originalFetch;
    }
  });
});

test("paid submission locks are per project and shot, so different shots can POST in parallel", async () => {
  await withJournal(async ({ journalPath }) => {
    let activePosts = 0;
    let maximumActivePosts = 0;
    const bothStarted = deferred();
    const releasePosts = deferred();
    const originalFetch = global.fetch;
    global.fetch = async (_url, init = {}) => {
      if (init.method !== "POST") return new Response(JSON.stringify({ status: "running" }), { status: 200 });
      const body = JSON.parse(init.body);
      activePosts += 1;
      maximumActivePosts = Math.max(maximumActivePosts, activePosts);
      if (activePosts === 2) bothStarted.resolve();
      await releasePosts.promise;
      activePosts -= 1;
      const text = body.content[0].text;
      return new Response(JSON.stringify({ id: text.includes("shot two") ? "task-02" : "task-01", status: "queued" }), { status: 200 });
    };
    try {
      const manager = managerFor(journalPath).manager;
      const first = manager.submit(config, payload({ prompt: "shot one" }), "C:\\unused");
      const second = manager.submit(config, payload({ shotId: "shot-02", prompt: "shot two" }), "C:\\unused");
      await Promise.race([
        bothStarted.promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error("different shots did not reach fetch concurrently")), 1000)),
      ]);
      releasePosts.resolve();
      assert.deepEqual((await Promise.all([first, second])).map((result) => result.jobId).sort(), ["task-01", "task-02"]);
      assert.equal(maximumActivePosts, 2);
    } finally {
      releasePosts.resolve();
      global.fetch = originalFetch;
    }
  });
});

test("a failed paid POST releases its shot lock while the unknown journal still blocks ordinary retry", async () => {
  await withJournal(async ({ journalPath }) => {
    let postCount = 0;
    const originalFetch = global.fetch;
    global.fetch = async (_url, init = {}) => {
      if (init.method === "POST") postCount += 1;
      if (postCount === 1) throw new Error("simulated response loss");
      return new Response(JSON.stringify({ id: "confirmed-replacement", status: "queued" }), { status: 200 });
    };
    try {
      const { journal, manager } = managerFor(journalPath);
      await assert.rejects(manager.submit(config, payload(), "C:\\unused"), /可能已受理|任务 ID/);
      await assert.rejects(manager.submit(config, payload(), "C:\\unused"), /可能已受理|阻止自动再次提交/);
      assert.equal(postCount, 1, "unknown status must prevent an automatic retry POST");

      const authorization = await authorizeResubmit(manager);
      const replacement = await manager.resubmit(config, payload(), "C:\\unused", authorization);
      assert.equal(replacement.jobId, "confirmed-replacement");
      assert.equal(postCount, 2, "the released lock permits only the separately confirmed resubmit");
      assert.equal(journal.findTask(payload({ jobId: "confirmed-replacement" })).taskId, "confirmed-replacement");
    } finally { global.fetch = originalFetch; }
  });
});

test("an unexpected task-id conflict fails closed and retains every accepted id for audit", async () => {
  await withJournal(async ({ journalPath }) => {
    const { createPaidTaskJournal } = loadPaidTaskModule();
    const journal = createPaidTaskJournal(journalPath);
    const { identity } = journal.recordSubmissionIntent(payload(), config);
    journal.recordTaskId(identity, { jobId: "accepted-first", status: "queued" });
    await assert.rejects(
      async () => journal.recordTaskId(identity, { jobId: "accepted-conflict", status: "queued" }),
      /冲突|全部任务 ID|人工核查/,
    );
    const entry = journal.list(payload().projectId)[0];
    assert.ok([entry.taskId, ...(entry.previousTaskIds || [])].includes("accepted-first"));
    assert.ok([entry.taskId, ...(entry.previousTaskIds || [])].includes("accepted-conflict"));
  });
});
