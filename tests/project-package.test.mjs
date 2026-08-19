import test from "node:test";
import assert from "node:assert/strict";
import { importedPackageSummary, parseProjectPackageText } from "../app/project-package.mjs";

const valid = { version: 9, projectName: "旧项目", script: "完整文稿。", shots: [{ id: "shot-01", narration: "完整文稿。", duration: 3 }] };

test("reads a saved story project and reports its contents", () => {
  const project = parseProjectPackageText(JSON.stringify(valid));
  assert.equal(project.projectName, "旧项目");
  assert.deepEqual(importedPackageSummary(project), { name: "旧项目", shots: 1, hasVoice: false, hasMusic: false });
});

test("accepts current packages containing manual characters and per-shot overrides", () => {
  const current = { ...valid, version: 12, creationMode: "short_drama", manualCharacters: [{ id: "extra-lawyer", name: "律师", enabled: true }], shots: [{ ...valid.shots[0], characterSelectionMode: "manual", characterIds: ["extra-lawyer"] }] };
  assert.deepEqual(parseProjectPackageText(JSON.stringify(current)).shots[0].characterIds, ["extra-lawyer"]);
});

test("rejects malformed or unsupported project packages", () => {
  assert.throws(() => parseProjectPackageText("not-json"), /JSON/);
  assert.throws(() => parseProjectPackageText(JSON.stringify({ ...valid, version: 99 })), /版本/);
  assert.throws(() => parseProjectPackageText(JSON.stringify({ ...valid, shots: [{ narration: "坏镜头", duration: 0 }] })), /时长/);
});
