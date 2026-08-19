import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const providers = require("../desktop/providers.cjs");

async function withMedia(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mujing-provider-stream-"));
  const mediaDir = path.join(directory, "media");
  fs.mkdirSync(mediaDir, { recursive: true });
  try { await run(mediaDir); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

function fakeResponse(chunks, { contentLength, contentEncoding, failAt = -1 } = {}) {
  let index = 0;
  let arrayBufferCalls = 0;
  return {
    ok: true,
    headers: new Headers({
      ...(contentLength === undefined ? {} : { "content-length": String(contentLength) }),
      ...(contentEncoding ? { "content-encoding": contentEncoding } : {}),
    }),
    body: {
      getReader() {
        return {
          async read() {
            if (index === failAt) throw new Error("simulated transport interruption");
            if (index >= chunks.length) return { done: true };
            return { done: false, value: chunks[index++] };
          },
          async cancel() {},
          releaseLock() {},
        };
      },
    },
    async arrayBuffer() { arrayBufferCalls += 1; throw new Error("whole-buffer path must not run"); },
    arrayBufferCalls: () => arrayBufferCalls,
  };
}

async function assertNoFiles(mediaDir) {
  const entries = await readdir(mediaDir, { recursive: true });
  assert.deepEqual(entries, []);
}

test("Content-Length over limit is rejected before reading and leaves no temp or media file", async () => {
  await withMedia(async (mediaDir) => {
    const response = fakeResponse([Buffer.from("not-read")], { contentLength: 9 });
    await assert.rejects(providers.streamResponseToMedia(response, mediaDir, { maxBytes: 8, extension: "mp3", prefix: "voice" }), /超过|上限|Content-Length/);
    assert.equal(response.arrayBufferCalls(), 0);
    await assertNoFiles(mediaDir);
  });
});

test("chunked response crossing the limit is stopped incrementally and temp is removed", async () => {
  await withMedia(async (mediaDir) => {
    const response = fakeResponse([Buffer.alloc(5, 1), Buffer.alloc(5, 2)]);
    await assert.rejects(providers.streamResponseToMedia(response, mediaDir, { maxBytes: 8, extension: "mp4", prefix: "video" }), /超过|上限/);
    assert.equal(response.arrayBufferCalls(), 0);
    await assertNoFiles(mediaDir);
  });
});

test("interrupted response removes temp and never exposes a formal media file", async () => {
  await withMedia(async (mediaDir) => {
    const response = fakeResponse([Buffer.alloc(4)], { failAt: 1 });
    await assert.rejects(providers.streamResponseToMedia(response, mediaDir, { maxBytes: 8, extension: "mp4", prefix: "video" }), /中断|interruption|下载/);
    assert.equal(response.arrayBufferCalls(), 0);
    await assertNoFiles(mediaDir);
  });
});

test("small response is streamed to one atomically published media file", async () => {
  await withMedia(async (mediaDir) => {
    const response = fakeResponse([Buffer.from("abc"), Buffer.from("def")], { contentLength: 6 });
    const result = await providers.streamResponseToMedia(response, mediaDir, { maxBytes: 8, extension: "mp3", prefix: "voice" });
    assert.equal(response.arrayBufferCalls(), 0);
    assert.deepEqual(await readFile(path.join(mediaDir, result.filename)), Buffer.from("abcdef"));
    assert.deepEqual(await readdir(mediaDir), [result.filename]);
  });
});

test("a transparently decoded compressed media response uses the decoded streaming byte limit", async () => {
  await withMedia(async (mediaDir) => {
    const response = fakeResponse([Buffer.from("abcdef")], { contentLength: 3, contentEncoding: "gzip" });
    const result = await providers.streamResponseToMedia(response, mediaDir, { maxBytes: 8, extension: "bin", prefix: "media" });
    assert.deepEqual(await readFile(path.join(mediaDir, result.filename)), Buffer.from("abcdef"));
  });
});
