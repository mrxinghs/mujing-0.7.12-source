import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { VALID_PNG } from "./image-fixtures.mjs";

const require = createRequire(import.meta.url);
const { saveImageDataUrl, MAX_MEDIA_IMAGE_BYTES } = require("../desktop/media-save-data-url.cjs");
const LIMIT = 12 * 1024 * 1024;

function encoded(bytes, mime = "image/png") {
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

function harness(options = {}) {
  let writes = 0;
  let decodes = 0;
  let written;
  const save = (payload) => saveImageDataUrl(payload, "C:\\unused", {
    decodeBase64(value) { decodes += 1; return Buffer.from(value, "base64"); },
    ...(options.decodeImage ? { decodeImage: options.decodeImage } : {}),
    writeMedia(_mediaDir, buffer, extension, prefix) { writes += 1; written = { buffer, extension, prefix }; return `${prefix}.${extension}`; },
  });
  return { save, writes: () => writes, decodes: () => decodes, written: () => written };
}

test("generic image IPC uses the unified 12 MiB decoded limit and trusted MIME extension", () => {
  assert.equal(MAX_MEDIA_IMAGE_BYTES, LIMIT);
  const testHarness = harness({ decodeImage: () => true });
  const exactImage = Buffer.concat([VALID_PNG, Buffer.alloc(LIMIT - VALID_PNG.length)]);
  const result = testHarness.save({ dataUrl: encoded(exactImage), prefix: "../../renderer-name.mp4" });
  assert.equal(result.filename, "image.png");
  assert.equal(testHarness.writes(), 1);
  assert.equal(testHarness.written().buffer.length, LIMIT);
  assert.equal(testHarness.written().extension, "png");
});

test("limit plus one and 16 MiB are rejected with zero write, and 16 MiB is rejected before decode", () => {
  const over = harness();
  assert.throws(() => over.save({ dataUrl: encoded(Buffer.alloc(LIMIT + 1)) }), /图片素材不能超过12 MiB/);
  assert.equal(over.writes(), 0);

  const huge = harness();
  const sixteenMiBEncoded = "A".repeat(Math.ceil((16 * 1024 * 1024) / 3) * 4);
  assert.throws(() => huge.save({ dataUrl: `data:image/png;base64,${sixteenMiBEncoded}` }), /图片素材不能超过12 MiB/);
  assert.equal(huge.decodes(), 0);
  assert.equal(huge.writes(), 0);
});

test("malformed base64 and non-image MIME are rejected with zero write", () => {
  for (const dataUrl of ["data:image/png;base64,AB=C", "data:text/plain;base64,SGVsbG8="]) {
    const testHarness = harness();
    assert.throws(() => testHarness.save({ dataUrl }), /图片|base64|MIME/);
    assert.equal(testHarness.writes(), 0);
  }
});

test("decoded byte limit is checked again before any write", () => {
  let writes = 0;
  assert.throws(() => saveImageDataUrl({ dataUrl: "data:image/png;base64,AAAA" }, "C:\\unused", {
    decodeBase64() { return Buffer.alloc(LIMIT + 1); },
    writeMedia() { writes += 1; },
  }), /图片素材不能超过12 MiB/);
  assert.equal(writes, 0);
});

test("script bytes, truncated images, and MIME mismatches are decoder-rejected with zero write", () => {
  const cases = [
    encoded(Buffer.from("<script>alert('x')</script>"), "image/png"),
    encoded(Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"), "image/png"),
    encoded(Buffer.from("ffd8ffe000104a464946", "hex"), "image/jpeg"),
    encoded(Buffer.from("524946460400000057454250", "hex"), "image/webp"),
    encoded(Buffer.from("ffd8ffe000104a464946", "hex"), "image/png"),
  ];
  for (const dataUrl of cases) {
    const testHarness = harness();
    assert.throws(() => testHarness.save({ dataUrl }), /图片.*解码|格式.*不匹配|损坏/);
    assert.equal(testHarness.writes(), 0);
  }
});
