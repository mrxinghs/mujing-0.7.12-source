import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { resolveE2EExportPath } = require("../desktop/e2e-gate.cjs");

test("E2E export path is unavailable in every packaged build", () => {
  assert.equal(resolveE2EExportPath({ isPackaged: true, enabled: "1", outputPath: "C:\\temp\\result.mp4" }), "");
  assert.equal(resolveE2EExportPath({ isPackaged: true, enabled: "0", outputPath: "C:\\temp\\result.mp4" }), "");
});

test("E2E export path requires an explicit non-packaged gate", () => {
  assert.equal(resolveE2EExportPath({ isPackaged: false, enabled: "0", outputPath: "C:\\temp\\result.mp4" }), "");
  assert.equal(resolveE2EExportPath({ isPackaged: false, enabled: "1", outputPath: "" }), "");
  assert.match(resolveE2EExportPath({ isPackaged: false, enabled: "1", outputPath: "C:\\temp\\result.mp4" }), /result\.mp4$/);
});
