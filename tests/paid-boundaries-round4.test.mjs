import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { VALID_PNG, VALID_PNG_ALT } from "./image-fixtures.mjs";

const require = createRequire(import.meta.url);
const FIXED_IDENTITY_SECRET = Buffer.alloc(32, 0x5a);
const PNG_A = VALID_PNG;
const PNG_B = VALID_PNG_ALT;

async function withWorkspace(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mujing-paid-boundary-"));
  const journalPath = path.join(directory, "paid-video-tasks.json");
  const mediaDir = path.join(directory, "media");
  fs.mkdirSync(mediaDir, { recursive: true });
  try { await run({ directory, journalPath, mediaDir }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

function request(overrides = {}) {
  return {
    projectId: "project-round-4",
    shotId: "shot-01",
    provider: "Seedance",
    prompt: "PRIVATE PROMPT",
    ratio: "16:9",
    duration: 4,
    imageUrl: `data:image/png;base64,${PNG_A.toString("base64")}`,
    ...overrides,
  };
}

function providerConfig(overrides = {}) {
  return {
    apiKey: "ROUND4_TEST_KEY_ALPHA",
    baseUrl: "https://API.Example.invalid:443/v1/",
    videoModel: "video-test",
    ...overrides,
  };
}

function createHarness(journalPath, options = {}) {
  const { createPaidTaskJournal, createPaidTaskManager } = require("../desktop/paid-task-journal.cjs");
  const calls = [];
  const journal = createPaidTaskJournal(journalPath, {
    identitySecret: FIXED_IDENTITY_SECRET,
    ...options.journalOptions,
  });
  const manager = createPaidTaskManager({
    journal,
    resubmitAuthorizer: options.resubmitAuthorizer,
    submitTask: options.submitTask || (async (_config, paidRequest) => {
      calls.push({ method: "POST", request: paidRequest });
      return { jobId: `task-${calls.filter((call) => call.method === "POST").length}`, status: "queued" };
    }),
    pollTask: options.pollTask || (async (_config, paidRequest) => {
      calls.push({ method: "GET", request: paidRequest });
      return { jobId: paidRequest.jobId, status: "running" };
    }),
  });
  return { calls, journal, manager };
}

async function submitOriginal(harness, config, payload, mediaDir) {
  const submitted = await harness.manager.submit(config, payload, mediaDir);
  assert.equal(submitted.recovered, false);
  return submitted;
}

test("poll binds task id to normalized endpoint and HMAC account identity", async (t) => {
  await t.test("changed baseUrl fails closed with zero GET and zero additional POST", async () => {
    await withWorkspace(async ({ journalPath, mediaDir }) => {
      const harness = createHarness(journalPath);
      const original = await submitOriginal(harness, providerConfig(), request(), mediaDir);
      await assert.rejects(
        harness.manager.poll(providerConfig({ baseUrl: "https://other.example.invalid/v1" }), request({ jobId: original.jobId }), mediaDir),
        /Endpoint|账户|端点|恢复原|核查任务/,
      );
      assert.deepEqual(harness.calls.map((call) => call.method), ["POST"]);
    });
  });

  await t.test("changed API key fails closed with zero GET and zero additional POST", async () => {
    await withWorkspace(async ({ journalPath, mediaDir }) => {
      const harness = createHarness(journalPath);
      const original = await submitOriginal(harness, providerConfig(), request(), mediaDir);
      await assert.rejects(
        harness.manager.poll(providerConfig({ apiKey: "ROUND4_TEST_KEY_BETA" }), request({ jobId: original.jobId }), mediaDir),
        /Endpoint|账户|端点|恢复原|核查任务/,
      );
      assert.deepEqual(harness.calls.map((call) => call.method), ["POST"]);
    });
  });

  await t.test("equivalent endpoint spelling and the same account poll the original task", async () => {
    await withWorkspace(async ({ journalPath, mediaDir }) => {
      const harness = createHarness(journalPath);
      const original = await submitOriginal(harness, providerConfig(), request(), mediaDir);
      const result = await harness.manager.poll(
        providerConfig({ baseUrl: "https://api.example.invalid./%76%31" }),
        request({ jobId: original.jobId }),
        mediaDir,
      );
      assert.equal(result.status, "running");
      assert.deepEqual(harness.calls.map((call) => call.method), ["POST", "GET"]);
      assert.equal(harness.calls[1].request.jobId, original.jobId);
    });
  });

  await t.test("ordinary submit never recovers an old id under a changed endpoint or account", async () => {
    for (const changed of [
      providerConfig({ baseUrl: "https://replacement.example.invalid/v1" }),
      providerConfig({ apiKey: "ROUND4_TEST_KEY_REPLACED" }),
    ]) {
      await withWorkspace(async ({ journalPath, mediaDir }) => {
        const harness = createHarness(journalPath);
        await submitOriginal(harness, providerConfig(), request(), mediaDir);
        await assert.rejects(harness.manager.submit(changed, request(), mediaDir), /Endpoint|账户|端点|恢复原|核查任务/);
        assert.deepEqual(harness.calls.map((call) => call.method), ["POST"]);
      });
    }
  });

  await t.test("journal stores only irreversible identities and never the API key", async () => {
    await withWorkspace(async ({ journalPath, mediaDir }) => {
      const harness = createHarness(journalPath);
      await submitOriginal(harness, providerConfig(), request(), mediaDir);
      const disk = await readFile(journalPath, "utf8");
      assert.doesNotMatch(disk, /ROUND4_TEST_KEY_ALPHA|API\.Example\.invalid/);
      assert.match(disk, /endpointFingerprint/);
      assert.match(disk, /accountFingerprint/);
    });
  });
});

test("missing or corrupt persisted HMAC secret blocks old-task polling instead of minting a new identity", async () => {
  for (const scenario of ["missing", "corrupt"]) {
    await withWorkspace(async ({ directory, journalPath, mediaDir }) => {
      const secretPath = path.join(directory, "paid-task-identity.secret");
      const first = createHarness(journalPath, { journalOptions: { identitySecret: undefined, identitySecretPath: secretPath } });
      const original = await submitOriginal(first, providerConfig(), request(), mediaDir);
      assert.equal(fs.statSync(secretPath).size, 32);
      if (scenario === "missing") await rm(secretPath);
      else await writeFile(secretPath, Buffer.from("corrupt"));

      const restarted = createHarness(journalPath, { journalOptions: { identitySecret: undefined, identitySecretPath: secretPath } });
      await assert.rejects(
        restarted.manager.poll(providerConfig(), request({ jobId: original.jobId }), mediaDir),
        /身份|secret|损坏|缺失|核查任务/,
      );
      assert.equal(restarted.calls.length, 0, `${scenario} secret must issue no network operation`);
      if (scenario === "missing") assert.equal(fs.existsSync(secretPath), false, "poll must not replace a missing identity");
      else assert.equal(fs.statSync(secretPath).size, 7, "poll must not replace a corrupt identity");
    });
  }
});

test("the request fingerprint and provider upload are bound to one read of the real first-frame bytes", async (t) => {
  await t.test("same URL with changed file bytes is blocked before a second POST", async () => {
    await withWorkspace(async ({ journalPath, mediaDir }) => {
      const filename = "first-frame.png";
      const filePath = path.join(mediaDir, filename);
      await writeFile(filePath, PNG_A);
      const localUrl = `http://127.0.0.1:43123/__media/${filename}`;
      const harness = createHarness(journalPath);
      await submitOriginal(harness, providerConfig(), request({ imageUrl: localUrl }), mediaDir);
      await writeFile(filePath, PNG_B);
      await assert.rejects(harness.manager.submit(providerConfig(), request({ imageUrl: localUrl }), mediaDir), /输入已改变|首帧|恢复旧任务/);
      assert.deepEqual(harness.calls.map((call) => call.method), ["POST"]);
    });
  });

  await t.test("different safe media URLs with identical bytes recover the old task", async () => {
    await withWorkspace(async ({ journalPath, mediaDir }) => {
      await writeFile(path.join(mediaDir, "same.png"), PNG_A);
      const harness = createHarness(journalPath);
      const first = await submitOriginal(harness, providerConfig(), request({ imageUrl: "http://127.0.0.1:1111/__media/same.png" }), mediaDir);
      const recovered = await harness.manager.submit(providerConfig(), request({ imageUrl: "http://localhost:2222/__media/same.png" }), mediaDir);
      assert.equal(recovered.jobId, first.jobId);
      assert.equal(recovered.recovered, true);
      assert.deepEqual(harness.calls.map((call) => call.method), ["POST"]);
    });
  });

  await t.test("missing, out-of-media-root, and invalid data URLs all fail before POST", async () => {
    const invalidInputs = [
      "http://127.0.0.1:1111/__media/missing.png",
      "file:///C:/Windows/System32/notepad.exe",
      "data:image/png;base64,%%%not-base64%%%",
    ];
    for (const imageUrl of invalidInputs) {
      await withWorkspace(async ({ journalPath, mediaDir }) => {
        const harness = createHarness(journalPath);
        await assert.rejects(harness.manager.submit(providerConfig(), request({ imageUrl }), mediaDir), /首帧|素材|路径|data URL|读取/);
        assert.equal(harness.calls.length, 0, imageUrl);
      });
    }
  });

  await t.test("the exact buffered bytes used for the digest are handed to the provider and never enter the journal", async () => {
    await withWorkspace(async ({ journalPath, mediaDir }) => {
      const rawSecretBytes = PNG_A;
      let uploaded;
      const harness = createHarness(journalPath, {
        submitTask: async (_config, paidRequest) => {
          uploaded = paidRequest.firstFrameInput?.buffer;
          return { jobId: "buffer-bound-task", status: "queued" };
        },
      });
      const imageUrl = `data:image/png;base64,${rawSecretBytes.toString("base64")}`;
      await submitOriginal(harness, providerConfig(), request({ imageUrl }), mediaDir);
      assert.ok(Buffer.isBuffer(uploaded));
      assert.deepEqual(uploaded, rawSecretBytes);
      const disk = await readFile(journalPath, "utf8");
      assert.doesNotMatch(disk, new RegExp(rawSecretBytes.toString("base64")));
      assert.doesNotMatch(disk, /data:image/);
      assert.match(disk, /imageDigest/);
    });
  });

  await t.test("the real Seedance transport uploads the same buffered bytes under fake fetch", async () => {
    await withWorkspace(async ({ journalPath, mediaDir }) => {
      const providers = require("../desktop/providers.cjs");
      let uploadedBytes;
      const originalFetch = global.fetch;
      global.fetch = async (_url, init = {}) => {
        const body = JSON.parse(init.body);
        const uploadedUrl = body.content.find((part) => part.type === "image_url")?.image_url?.url;
        uploadedBytes = Buffer.from(uploadedUrl.split(",")[1], "base64");
        return new Response(JSON.stringify({ id: "provider-buffer-task", status: "queued" }), { status: 200 });
      };
      try {
        const harness = createHarness(journalPath, { submitTask: providers.submitVideoTask });
        await submitOriginal(harness, providerConfig(), request(), mediaDir);
        assert.deepEqual(uploadedBytes, PNG_A);
      } finally { global.fetch = originalFetch; }
    });
  });
});

test("native-confirmed resubmit authorization is short-lived, one-shot, and context-bound", async (t) => {
  const { createPaidResubmitAuthorizer } = require("../desktop/paid-resubmit-authorization.cjs");

  async function authorizedHarness(run, options = {}) {
    await withWorkspace(async ({ journalPath, mediaDir }) => {
      let clock = 10_000;
      let nonce = 0;
      const authorizer = createPaidResubmitAuthorizer({
        now: () => clock,
        randomBytes: () => Buffer.alloc(32, ++nonce),
        ttlMs: 60_000,
      });
      const harness = createHarness(journalPath, { resubmitAuthorizer: authorizer, ...options });
      const original = await submitOriginal(harness, providerConfig(), request(), mediaDir);
      await run({ authorizer, clock: () => clock, setClock: (value) => { clock = value; }, harness, mediaDir, original });
    });
  }

  await t.test("native rejection returns no token and performs no resubmit POST", async () => {
    await authorizedHarness(async ({ harness, mediaDir }) => {
      const before = harness.calls.length;
      const response = await harness.manager.requestResubmitAuthorization(providerConfig(), request(), mediaDir, {
        senderId: 17,
        confirm: async (notice) => {
          assert.match(`${notice.title}\n${notice.message}`, /放弃旧记录/);
          assert.match(notice.message, /旧远端.*继续计费|新增费用/);
          assert.match(notice.message, /Seedance.*shot-01|shot-01.*Seedance/s);
          return false;
        },
      });
      assert.deepEqual(response, { authorized: false });
      assert.equal(harness.calls.length, before);
    });
  });

  await t.test("one confirmation grants one token; replay and concurrent reuse permit at most one POST", async () => {
    await authorizedHarness(async ({ harness, mediaDir }) => {
      const grant = await harness.manager.requestResubmitAuthorization(providerConfig(), request(), mediaDir, { senderId: 17, confirm: async () => true });
      assert.equal(grant.authorized, true);
      assert.match(grant.token, /^[a-f0-9]{64}$/);
      const attempts = await Promise.allSettled([
        harness.manager.resubmit(providerConfig(), request({ authorizationToken: grant.token }), mediaDir, { senderId: 17, token: grant.token }),
        harness.manager.resubmit(providerConfig(), request({ authorizationToken: grant.token }), mediaDir, { senderId: 17, token: grant.token }),
      ]);
      assert.equal(attempts.filter((item) => item.status === "fulfilled").length, 1);
      assert.equal(attempts.filter((item) => item.status === "rejected").length, 1);
      assert.deepEqual(harness.calls.map((call) => call.method), ["POST", "POST"]);
      await assert.rejects(harness.manager.resubmit(providerConfig(), request(), mediaDir, { senderId: 17, token: grant.token }), /授权|过期|已使用/);
      assert.deepEqual(harness.calls.map((call) => call.method), ["POST", "POST"]);
    });
  });

  await t.test("expired, cross-sender, cross-shot, changed-input, and changed-account tokens all fail before POST", async () => {
    const scenarios = [
      { name: "expired", mutate: ({ setClock }) => setClock(70_001), senderId: 17, config: providerConfig(), payload: request() },
      { name: "cross-sender", mutate: () => {}, senderId: 18, config: providerConfig(), payload: request() },
      { name: "cross-shot", mutate: () => {}, senderId: 17, config: providerConfig(), payload: request({ shotId: "shot-02" }) },
      { name: "changed-input", mutate: () => {}, senderId: 17, config: providerConfig(), payload: request({ prompt: "CHANGED PROMPT" }) },
      { name: "changed-endpoint", mutate: () => {}, senderId: 17, config: providerConfig({ baseUrl: "https://other.example.invalid/v1" }), payload: request() },
      { name: "changed-account", mutate: () => {}, senderId: 17, config: providerConfig({ apiKey: "ROUND4_TEST_KEY_BETA" }), payload: request() },
    ];
    for (const scenario of scenarios) {
      await authorizedHarness(async ({ harness, mediaDir, setClock }) => {
        const grant = await harness.manager.requestResubmitAuthorization(providerConfig(), request(), mediaDir, { senderId: 17, confirm: async () => true });
        scenario.mutate({ setClock });
        await assert.rejects(
          harness.manager.resubmit(scenario.config, scenario.payload, mediaDir, { senderId: scenario.senderId, token: grant.token }),
          /授权|过期|匹配|已使用/,
          scenario.name,
        );
        assert.deepEqual(harness.calls.map((call) => call.method), ["POST"], scenario.name);
      });
    }
  });

  await t.test("renderer confirmation booleans cannot authorize a paid resubmit", async () => {
    await authorizedHarness(async ({ harness, mediaDir }) => {
      await assert.rejects(
        harness.manager.resubmit(providerConfig(), request({ confirmations: { abandonOldRecord: true, additionalCharge: true } }), mediaDir, {
          senderId: 17,
          confirmations: { abandonOldRecord: true, additionalCharge: true },
        }),
        /授权|token/i,
      );
      assert.deepEqual(harness.calls.map((call) => call.method), ["POST"]);
    });
  });
});
