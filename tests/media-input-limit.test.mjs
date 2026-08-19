import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { VALID_JPEG, VALID_PNG, VALID_WEBP } from "./image-fixtures.mjs";

const require = createRequire(import.meta.url);
const mediaInput = require("../desktop/media-input.cjs");
const { createPaidTaskJournal, createPaidTaskManager } = require("../desktop/paid-task-journal.cjs");
const {
  FIRST_FRAME_SIZE_LIMIT_MESSAGE,
  MAX_PAID_VIDEO_FIRST_FRAME_BYTES,
  readPaidVideoFirstFrame,
} = mediaInput;

const EXPECTED_MAX_BYTES = 12 * 1024 * 1024;
const LIMIT_PATTERN = /首帧图片不能超过12 MiB/;
const SMALL_IMAGES = [
  { mimeType: "image/png", bytes: VALID_PNG },
  { mimeType: "image/jpeg", bytes: VALID_JPEG },
  { mimeType: "image/webp", bytes: VALID_WEBP },
];

async function withWorkspace(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mujing-first-frame-limit-"));
  const mediaDir = path.join(directory, "media");
  fs.mkdirSync(mediaDir, { recursive: true });
  try { await run({ directory, mediaDir }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

function dataUrl(mimeType, bytes) {
  return `data:${mimeType};base64,${bytes.toString("base64")}`;
}

function payload(imageUrl, overrides = {}) {
  return {
    projectId: "project-first-frame-limit",
    shotId: "shot-01",
    provider: "Seedance",
    prompt: "offline size-boundary test",
    ratio: "16:9",
    duration: 4,
    imageUrl,
    ...overrides,
  };
}

function config() {
  return { apiKey: "TEST_ONLY_KEY", baseUrl: "https://example.invalid/v1", videoModel: "video-test" };
}

function managerHarness(journalPath) {
  let posts = 0;
  let received;
  const journal = createPaidTaskJournal(journalPath, { identitySecret: Buffer.alloc(32, 0x6c) });
  const manager = createPaidTaskManager({
    journal,
    submitTask: async (_providerConfig, request) => {
      posts += 1;
      received = request.firstFrameInput;
      return { jobId: `size-task-${posts}`, status: "queued" };
    },
    pollTask: async () => { throw new Error("GET must not run in first-frame input tests"); },
  });
  return { journal, manager, posts: () => posts, received: () => received };
}

test("paid first-frame limit is one exported 12 MiB byte constant with matching Chinese copy", () => {
  assert.equal(MAX_PAID_VIDEO_FIRST_FRAME_BYTES, EXPECTED_MAX_BYTES);
  assert.equal(FIRST_FRAME_SIZE_LIMIT_MESSAGE, "首帧图片不能超过12 MiB");
});

test("data URL accepts exactly the limit, binds its real digest, and journals no image copy", async () => {
  await withWorkspace(async ({ directory, mediaDir }) => {
    const bytes = Buffer.concat([VALID_PNG, Buffer.alloc(EXPECTED_MAX_BYTES - VALID_PNG.length, 0x61)]);
    const encoded = dataUrl("image/png", bytes);
    const journalPath = path.join(directory, "paid-video-tasks.json");
    const harness = managerHarness(journalPath);

    await harness.manager.submit(config(), payload(encoded), mediaDir);

    assert.equal(harness.posts(), 1);
    assert.equal(harness.received().buffer.length, EXPECTED_MAX_BYTES);
    assert.equal(harness.received().digest, crypto.createHash("sha256").update(bytes).digest("hex"));
    const journalText = await readFile(journalPath, "utf8");
    assert.ok(journalText.length < 20_000, "journal must not retain a large image/base64 copy");
    assert.doesNotMatch(journalText, /data:image|YWFhYWFhYWFh/);
  });
});

test("data URL rejects limit plus one with zero POST", async () => {
  await withWorkspace(async ({ directory, mediaDir }) => {
    const encoded = dataUrl("image/png", Buffer.alloc(EXPECTED_MAX_BYTES + 1, 0x62));
    const harness = managerHarness(path.join(directory, "paid-video-tasks.json"));
    await assert.rejects(harness.manager.submit(config(), payload(encoded), mediaDir), LIMIT_PATTERN);
    assert.equal(harness.posts(), 0);
  });
});

test("16 MiB data URL is stopped by encoded length before the base64 decoder allocation", () => {
  const sixteenMiBEncodedPayload = "A".repeat(Math.ceil((16 * 1024 * 1024) / 3) * 4);
  let decoderCalls = 0;
  assert.throws(
    () => readPaidVideoFirstFrame("C:\\unused", `data:image/png;base64,${sixteenMiBEncodedPayload}`, {
      decodeBase64() {
        decoderCalls += 1;
        throw new Error("decoder probe must not be reached");
      },
    }),
    LIMIT_PATTERN,
  );
  assert.equal(decoderCalls, 0);
});

test("oversized sparse local file is rejected from descriptor stat without a full read or POST", async () => {
  await withWorkspace(async ({ directory, mediaDir }) => {
    const filename = "oversized-sparse.png";
    const filePath = path.join(mediaDir, filename);
    fs.closeSync(fs.openSync(filePath, "w"));
    fs.truncateSync(filePath, EXPECTED_MAX_BYTES + 1);
    let readFileCalls = 0;
    let readCalls = 0;
    const io = new Proxy(fs, {
      get(target, property) {
        if (property === "readFileSync") return (...args) => { readFileCalls += 1; return target.readFileSync(...args); };
        if (property === "readSync") return (...args) => { readCalls += 1; return target.readSync(...args); };
        return Reflect.get(target, property);
      },
    });
    const localUrl = `http://127.0.0.1/__media/${filename}`;

    assert.throws(() => readPaidVideoFirstFrame(mediaDir, localUrl, { fs: io }), LIMIT_PATTERN);
    assert.equal(readFileCalls, 0);
    assert.equal(readCalls, 0);

    const harness = managerHarness(path.join(directory, "paid-video-tasks.json"));
    await assert.rejects(harness.manager.submit(config(), payload(localUrl), mediaDir), LIMIT_PATTERN);
    assert.equal(harness.posts(), 0);
  });
});

test("descriptor-limited local read rejects a file that grows after fstat", async () => {
  await withWorkspace(async ({ mediaDir }) => {
    const filename = "growing.png";
    const filePath = path.join(mediaDir, filename);
    await writeFile(filePath, Buffer.from("small"));
    let readFileCalls = 0;
    let readCalls = 0;
    let grew = false;
    const io = new Proxy(fs, {
      get(target, property) {
        if (property === "readFileSync") return (...args) => { readFileCalls += 1; return target.readFileSync(...args); };
        if (property === "readSync") {
          return (...args) => {
            readCalls += 1;
            if (!grew) {
              grew = true;
              target.truncateSync(filePath, EXPECTED_MAX_BYTES + 1);
            }
            return target.readSync(...args);
          };
        }
        return Reflect.get(target, property);
      },
    });

    assert.throws(
      () => readPaidVideoFirstFrame(mediaDir, `http://localhost/__media/${filename}`, { fs: io }),
      LIMIT_PATTERN,
    );
    assert.equal(readFileCalls, 0);
    assert.ok(readCalls >= 1);
  });
});

test("exact-limit local descriptor read succeeds and returns the bytes that were digested", async () => {
  await withWorkspace(async ({ mediaDir }) => {
    const filename = "exact.webp";
    const filePath = path.join(mediaDir, filename);
    const bytes = Buffer.concat([VALID_WEBP, Buffer.alloc(EXPECTED_MAX_BYTES - VALID_WEBP.length, 0x7c)]);
    await writeFile(filePath, bytes);

    const result = readPaidVideoFirstFrame(mediaDir, `https://localhost/__media/${filename}`);

    assert.equal(result.buffer.length, EXPECTED_MAX_BYTES);
    assert.equal(result.mimeType, "image/webp");
    assert.equal(result.digest, crypto.createHash("sha256").update(bytes).digest("hex"));
  });
});

test("malformed base64, non-image MIME, and out-of-root path all fail with zero POST", async () => {
  const invalidInputs = [
    "data:image/png;base64,AB=C",
    "data:text/plain;base64,SGVsbG8=",
    "http://localhost/__media/%2e%2e%2foutside.png",
  ];
  for (const [index, imageUrl] of invalidInputs.entries()) {
    await withWorkspace(async ({ directory, mediaDir }) => {
      const harness = managerHarness(path.join(directory, "paid-video-tasks.json"));
      await assert.rejects(
        harness.manager.submit(config(), payload(imageUrl, { shotId: `invalid-${index}` }), mediaDir),
        /首帧|图片|MIME|data URL|路径/,
      );
      assert.equal(harness.posts(), 0, imageUrl);
    });
  }
});

test("small PNG, JPEG, and WebP data URLs still pass with real-byte digest binding", async () => {
  for (const [index, image] of SMALL_IMAGES.entries()) {
    await withWorkspace(async ({ directory, mediaDir }) => {
      const harness = managerHarness(path.join(directory, "paid-video-tasks.json"));
      await harness.manager.submit(
        config(),
        payload(dataUrl(image.mimeType, image.bytes), { shotId: `valid-${index}` }),
        mediaDir,
      );
      assert.equal(harness.posts(), 1);
      assert.strictEqual(harness.received().buffer.length, image.bytes.length);
      assert.deepEqual(harness.received().buffer, image.bytes);
      assert.equal(harness.received().mimeType, image.mimeType);
      assert.equal(harness.received().digest, crypto.createHash("sha256").update(image.bytes).digest("hex"));
    });
  }
});
