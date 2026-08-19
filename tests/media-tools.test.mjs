import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { durationFromProbe } = require("../desktop/media-tools.cjs");

test("media duration prefers a real stream duration", () => {
  assert.equal(durationFromProbe({ duration: "2.5" }, { duration: "9" }), 2.5);
});

test("media duration accepts valid WebM container duration", () => {
  assert.equal(durationFromProbe({ duration: "N/A", time_base: "1/1000" }, { duration: "2.125000" }), 2.125);
});

test("media duration rejects missing or non-positive metadata", () => {
  assert.equal(durationFromProbe({ duration: "N/A" }, { duration: "0" }), 0);
});
