import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { VALID_PNG } from "./image-fixtures.mjs";

const require = createRequire(import.meta.url);
const providers = require("../desktop/providers.cjs");
const { imageDimensionsFromBuffer } = require("../desktop/media-tools.cjs");

function fakeJsonResponse(chunks, { contentLength, contentEncoding, failAt = -1 } = {}) {
  let reads = 0;
  let cancels = 0;
  let jsonCalls = 0;
  let index = 0;
  return {
    ok: true,
    status: 200,
    headers: new Headers({
      "content-type": "application/json",
      ...(contentLength === undefined ? {} : { "content-length": String(contentLength) }),
      ...(contentEncoding ? { "content-encoding": contentEncoding } : {}),
    }),
    body: {
      getReader() {
        return {
          async read() {
            reads += 1;
            if (index === failAt) throw new Error("simulated JSON transport interruption");
            if (index >= chunks.length) return { done: true };
            return { done: false, value: chunks[index++] };
          },
          async cancel() { cancels += 1; },
          releaseLock() {},
        };
      },
    },
    async json() { jsonCalls += 1; throw new Error("response.json() must never be used for image provider envelopes"); },
    observations() { return { reads, cancels, jsonCalls }; },
  };
}

async function withMedia(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mujing-image-envelope-"));
  const mediaDir = path.join(directory, "media");
  try { await run(mediaDir); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test("oversized image JSON Content-Length is rejected before body read or JSON.parse", async () => {
  const response = fakeJsonResponse([Buffer.from("not read")], { contentLength: providers.MAX_IMAGE_JSON_ENVELOPE_BYTES + 1 });
  let parses = 0;
  await assert.rejects(providers.readBoundedJsonResponse(response, {
    maxBytes: providers.MAX_IMAGE_JSON_ENVELOPE_BYTES,
    parseJson(text) { parses += 1; return JSON.parse(text); },
  }), /Content-Length.*上限|JSON.*上限/);
  assert.deepEqual(response.observations(), { reads: 0, cancels: 1, jsonCalls: 0 });
  assert.equal(parses, 0);
});

test("oversized incomplete b64_json stops at envelope +1 and never reaches JSON.parse", async () => {
  const max = providers.MAX_IMAGE_JSON_ENVELOPE_BYTES;
  const oversizedPrefix = Buffer.alloc(max, 0x41);
  Buffer.from('{"data":[{"b64_json":"').copy(oversizedPrefix);
  const response = fakeJsonResponse([oversizedPrefix, Buffer.from("A")]);
  let parses = 0;
  await assert.rejects(providers.readBoundedJsonResponse(response, {
    maxBytes: max,
    parseJson() { parses += 1; throw new Error("must not parse"); },
  }), /JSON.*上限/);
  assert.deepEqual(response.observations(), { reads: 2, cancels: 1, jsonCalls: 0 });
  assert.equal(parses, 0);
});

test("an exactly-at-limit bounded JSON envelope can complete and parse", async () => {
  const max = providers.MAX_IMAGE_JSON_ENVELOPE_BYTES;
  const json = Buffer.from('{"data":[]}');
  const exact = Buffer.alloc(max, 0x20);
  json.copy(exact);
  const response = fakeJsonResponse([exact], { contentLength: max });
  const parsed = await providers.readBoundedJsonResponse(response, { maxBytes: max });
  assert.deepEqual(parsed, { data: [] });
  assert.equal(response.observations().jsonCalls, 0);
});

test("a transparently decoded gzip JSON response does not compare decoded bytes to compressed Content-Length", async () => {
  const json = Buffer.from('{"id":"compressed-task","status":"queued"}');
  const response = fakeJsonResponse([json], { contentLength: 19, contentEncoding: "gzip" });
  const parsed = await providers.readBoundedJsonResponse(response, { maxBytes: 1024 });
  assert.deepEqual(parsed, { id: "compressed-task", status: "queued" });
});

test("createImage reads a bounded envelope, validates base64 image bytes, and atomically publishes", async () => {
  await withMedia(async (mediaDir) => {
    const json = Buffer.from(JSON.stringify({ data: [{ b64_json: VALID_PNG.toString("base64") }] }));
    const response = fakeJsonResponse([json.subarray(0, 11), json.subarray(11)], { contentLength: json.length });
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => response;
    try {
      const result = await providers.createImage({ apiKey: "fake", imageModel: "fake" }, { prompt: "test", ratio: "16:9" }, mediaDir);
      assert.deepEqual(await readFile(path.join(mediaDir, result.filename)), VALID_PNG);
      assert.deepEqual(await readdir(mediaDir), [result.filename]);
      assert.equal(response.observations().jsonCalls, 0);
    } finally { globalThis.fetch = previousFetch; }
  });
});

test("renderer-enforced image generation publishes the exact selected project aspect", async () => {
  for (const [ratio, expected] of [["16:9", { width: 1536, height: 864 }], ["9:16", { width: 864, height: 1536 }]]) {
    await withMedia(async (mediaDir) => {
      const json = Buffer.from(JSON.stringify({ data: [{ b64_json: VALID_PNG.toString("base64") }] }));
      const response = fakeJsonResponse([json], { contentLength: json.length });
      const previousFetch = globalThis.fetch;
      globalThis.fetch = async () => response;
      try {
        const result = await providers.createImage({ apiKey: "fake", imageModel: "fake" }, { prompt: "test", ratio, enforceAspect: true }, mediaDir);
        const buffer = await readFile(path.join(mediaDir, result.filename));
        assert.deepEqual(imageDimensionsFromBuffer(buffer), expected);
      } finally { globalThis.fetch = previousFetch; }
    });
  }
});

test("URL image envelopes use the smaller JSON limit and do not read an oversized body", async () => {
  await withMedia(async (mediaDir) => {
    const response = fakeJsonResponse([Buffer.from("not read")], { contentLength: providers.MAX_URL_JSON_ENVELOPE_BYTES + 1 });
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => response;
    try {
      await assert.rejects(providers.createImage(
        { apiKey: "fake", imageModel: "seedream-fake" },
        { provider: "Seedream", prompt: "test", ratio: "16:9" },
        mediaDir,
      ), /Content-Length.*上限|JSON.*上限/);
      assert.deepEqual(response.observations(), { reads: 0, cancels: 1, jsonCalls: 0 });
      assert.equal(fs.existsSync(mediaDir), false);
    } finally { globalThis.fetch = previousFetch; }
  });
});

test("interrupted image JSON transport publishes no temp or formal file", async () => {
  await withMedia(async (mediaDir) => {
    const response = fakeJsonResponse([Buffer.from('{"data":[')], { failAt: 1 });
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => response;
    try {
      await assert.rejects(providers.createImage({ apiKey: "fake" }, { prompt: "test", ratio: "16:9" }, mediaDir), /传输中断|interruption/);
      assert.equal(response.observations().jsonCalls, 0);
      assert.equal(fs.existsSync(mediaDir), false);
    } finally { globalThis.fetch = previousFetch; }
  });
});

test("atomic image publication cleans temp on write failure and leaves no formal half-file", async () => {
  await withMedia(async (mediaDir) => {
    fs.mkdirSync(mediaDir, { recursive: true });
    await assert.rejects(providers.publishImageBufferAtomic(mediaDir, VALID_PNG, "png", {
      async writeBuffer(handle) {
        await handle.write(Buffer.from("partial"));
        throw new Error("simulated write failure");
      },
    }), /simulated write failure/);
    assert.deepEqual(await readdir(mediaDir), []);
  });
});

test("atomic base64 image publication removes its exclusive temp when rename fails", async () => {
  await withMedia(async (mediaDir) => {
    fs.mkdirSync(mediaDir, { recursive: true });
    await assert.rejects(providers.publishImageBufferAtomic(mediaDir, VALID_PNG, "png", {
      async beforeRename() { throw new Error("simulated rename failure"); },
    }), /simulated rename failure/);
    assert.deepEqual(await readdir(mediaDir), []);
  });
});
