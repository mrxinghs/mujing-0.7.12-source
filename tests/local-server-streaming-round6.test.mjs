import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const localServer = require("../desktop/local-server.cjs");

class FakeNodeResponse extends EventEmitter {
  constructor({ backpressureAt = -1 } = {}) {
    super();
    this.headers = new Map();
    this.chunks = [];
    this.statusCode = 200;
    this.headersSent = false;
    this.writableEnded = false;
    this.destroyed = false;
    this.backpressureAt = backpressureAt;
  }
  setHeader(key, value) { this.headers.set(String(key).toLowerCase(), String(value)); }
  write(chunk) {
    this.headersSent = true;
    this.chunks.push(Buffer.from(chunk));
    if (this.chunks.length === this.backpressureAt) {
      queueMicrotask(() => this.emit("drain"));
      return false;
    }
    return true;
  }
  end(chunk) {
    if (chunk) this.write(chunk);
    this.headersSent = true;
    this.writableEnded = true;
    this.emit("finish");
  }
  destroy(error) { this.destroyed = true; this.destroyError = error; this.emit("close"); }
}

function webResponse(chunks, { contentLength, failAt = -1 } = {}) {
  let reads = 0;
  let cancels = 0;
  let index = 0;
  return {
    status: 200,
    headers: new Headers(contentLength === undefined ? { "content-type": "text/plain" } : { "content-type": "text/plain", "content-length": String(contentLength) }),
    body: {
      getReader() {
        return {
          async read() {
            reads += 1;
            if (index === failAt) throw new Error("worker interrupted");
            if (index >= chunks.length) return { done: true };
            return { done: false, value: chunks[index++] };
          },
          async cancel() { cancels += 1; },
          releaseLock() {},
        };
      },
    },
    observations() { return { reads, cancels }; },
  };
}

test("loopback limits are explicit and exported", () => {
  assert.equal(localServer.MAX_LOOPBACK_REQUEST_BYTES, 32 * 1024 * 1024);
  assert.equal(localServer.MAX_LOOPBACK_RESPONSE_BYTES, 128 * 1024 * 1024);
});

test("request Content-Length over limit accumulates zero chunks", async () => {
  const request = new PassThrough();
  request.method = "POST";
  request.headers = { "content-length": String(localServer.MAX_LOOPBACK_REQUEST_BYTES + 1) };
  let concats = 0;
  await assert.rejects(localServer.requestBody(request, { concat() { concats += 1; } }), (error) => error?.statusCode === 413);
  assert.equal(concats, 0);
});

test("chunked request crossing +1 stops without Buffer.concat and interrupted request rejects", async () => {
  const request = new PassThrough();
  request.method = "POST";
  request.headers = {};
  let concats = 0;
  const pending = localServer.requestBody(request, { maxBytes: 8, concat() { concats += 1; } });
  request.write(Buffer.alloc(8));
  request.write(Buffer.alloc(1));
  await assert.rejects(pending, (error) => error?.statusCode === 413);
  assert.equal(concats, 0);

  const interrupted = new PassThrough();
  interrupted.method = "POST";
  interrupted.headers = {};
  const interruptedPending = localServer.requestBody(interrupted, { maxBytes: 8 });
  interrupted.write(Buffer.from("abc"));
  interrupted.emit("aborted");
  await assert.rejects(interruptedPending, /中断|aborted/i);
});

test("small request body is collected once and GET body is never collected", async () => {
  const request = new PassThrough();
  request.method = "POST";
  request.headers = { "content-length": "6" };
  let concats = 0;
  const pending = localServer.requestBody(request, { maxBytes: 8, concat(chunks, total) { concats += 1; return Buffer.concat(chunks, total); } });
  request.end(Buffer.from("abcdef"));
  assert.deepEqual(await pending, Buffer.from("abcdef"));
  assert.equal(concats, 1);
  assert.equal(localServer.methodNeedsBody("GET"), false);
  assert.equal(localServer.methodNeedsBody("HEAD"), false);
});

test("response Content-Length over limit reads zero body chunks and cancels", async () => {
  const source = webResponse([Buffer.from("not read")], { contentLength: 9 });
  const response = new FakeNodeResponse();
  await assert.rejects(localServer.sendWorkerResponse(source, response, { maxBytes: 8 }), /Content-Length.*上限|响应.*上限/);
  assert.deepEqual(source.observations(), { reads: 0, cancels: 1 });
  assert.equal(response.chunks.length, 0);
});

test("chunked response +1 cancels and destroys after a partial response", async () => {
  const source = webResponse([Buffer.alloc(8), Buffer.alloc(1)]);
  const response = new FakeNodeResponse();
  await assert.rejects(localServer.sendWorkerResponse(source, response, { maxBytes: 8 }), /响应.*上限/);
  assert.deepEqual(source.observations(), { reads: 2, cancels: 1 });
  assert.equal(response.destroyed, true);
});

test("normal multi-chunk response honors backpressure and worker interruption is not success", async () => {
  const source = webResponse([Buffer.from("abc"), Buffer.from("def")], { contentLength: 6 });
  const response = new FakeNodeResponse({ backpressureAt: 1 });
  await localServer.sendWorkerResponse(source, response, { maxBytes: 8 });
  assert.equal(Buffer.concat(response.chunks).toString(), "abcdef");
  assert.equal(response.writableEnded, true);
  assert.equal(response.destroyed, false);

  const brokenSource = webResponse([Buffer.from("abc")], { failAt: 1 });
  const brokenResponse = new FakeNodeResponse();
  await assert.rejects(localServer.sendWorkerResponse(brokenSource, brokenResponse, { maxBytes: 8 }), /worker interrupted/);
  assert.equal(brokenResponse.writableEnded, false);
  assert.equal(brokenResponse.destroyed, true);
  assert.equal(brokenSource.observations().cancels, 1);
});

test("client abort cancels a pending worker reader without an unhandled success", async () => {
  let cancels = 0;
  const source = {
    status: 200,
    headers: new Headers(),
    body: {
      getReader() {
        return {
          read() { return new Promise(() => {}); },
          async cancel() { cancels += 1; },
          releaseLock() {},
        };
      },
    },
  };
  const response = new FakeNodeResponse();
  const pending = localServer.sendWorkerResponse(source, response, { maxBytes: 8 });
  queueMicrotask(() => response.destroy(new Error("client aborted")));
  await assert.rejects(pending, /连接已中断/);
  assert.equal(cancels, 1);
  assert.equal(response.writableEnded, false);
});
