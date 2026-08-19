import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { _test: renderTest } = require("../desktop/render.cjs");

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mujing-pair-publish-"));
  const sourceOutput = path.join(directory, "rendered.mp4");
  const outputPath = path.join(directory, "movie.mp4");
  const manifestPath = path.join(directory, "movie.render-manifest.json");
  await writeFile(sourceOutput, "new movie");
  return { directory, sourceOutput, outputPath, manifestPath, manifest: { version: 2, kind: "complete-movie" } };
}

async function residues(directory) {
  return (await readdir(directory)).filter((name) => /(?:\.tmp|\.partial|\.backup|\.bak)(?:\.|$)/i.test(name));
}

async function recoveryState(directory) {
  const names = await readdir(directory);
  const backups = names.filter((name) => name.endsWith(".backup"));
  const metadata = names.filter((name) => name.endsWith(".recovery.json"));
  return { backups, metadata };
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function accessError(label) {
  return Object.assign(new Error(`${label} restore EACCES`), { code: "EACCES" });
}

async function capturedRejection(promise) {
  try { await promise; }
  catch (error) { return error; }
  assert.fail("expected promise to reject");
}

test("pair publication rejects a manifest directory before changing the output", async () => {
  const value = await fixture();
  try {
    await fs.promises.mkdir(value.manifestPath);
    await assert.rejects(renderTest.publishArtifactPair(value), /manifest|目录|文件/);
    assert.equal(fs.existsSync(value.outputPath), false);
    assert.deepEqual(await residues(value.directory), []);
  } finally { await rm(value.directory, { recursive: true, force: true }); }
});

for (const [name, hook] of [
  ["output rename failure", "beforeOutputCommit"],
  ["manifest rename failure", "beforeManifestCommit"],
  ["injected exception after first commit", "afterOutputCommit"],
]) {
  test(`pair publication leaves no new pair on ${name}`, async () => {
    const value = await fixture();
    try {
      await assert.rejects(renderTest.publishArtifactPair(value, { [hook]() { throw new Error(name); } }), new RegExp(name));
      assert.equal(fs.existsSync(value.outputPath), false);
      assert.equal(fs.existsSync(value.manifestPath), false);
      assert.deepEqual(await residues(value.directory), []);
    } finally { await rm(value.directory, { recursive: true, force: true }); }
  });
}

test("second commit failure restores an existing old MP4 and manifest pair", async () => {
  const value = await fixture();
  try {
    await writeFile(value.outputPath, "old movie");
    await writeFile(value.manifestPath, '{"version":1,"kind":"old"}\n');
    await assert.rejects(renderTest.publishArtifactPair(value, {
      beforeManifestCommit() { throw new Error("second commit failed"); },
    }), /second commit failed/);
    assert.equal(await readFile(value.outputPath, "utf8"), "old movie");
    assert.equal(await readFile(value.manifestPath, "utf8"), '{"version":1,"kind":"old"}\n');
    assert.deepEqual(await residues(value.directory), []);
  } finally { await rm(value.directory, { recursive: true, force: true }); }
});

for (const failed of ["output", "manifest", "both"]) {
  test(`rollback preserves verified recovery copies when ${failed} restore fails`, async () => {
    const value = await fixture();
    const oldOutput = Buffer.from("irreplaceable old movie bytes");
    const oldManifest = Buffer.from('{"version":1,"kind":"old"}\n');
    try {
      await writeFile(value.outputPath, oldOutput);
      await writeFile(value.manifestPath, oldManifest);
      const hooks = {
        ...(failed === "output"
          ? { beforeManifestCommit() { throw new Error("manifest commit failed"); } }
          : { afterManifestCommit() { throw new Error("manifest commit failed"); } }),
        ...(failed === "output" || failed === "both" ? { beforeOutputRecoveryRestore() { throw accessError("output"); } } : {}),
        ...(failed === "manifest" || failed === "both" ? { beforeManifestRecoveryRestore() { throw accessError("manifest"); } } : {}),
      };
      const error = await capturedRejection(renderTest.publishArtifactPair(value, hooks));
      assert.match(error.message, /manifest commit failed/);
      assert.match(error.message, new RegExp(`${failed === "both" ? "output|manifest" : failed}.*restore EACCES`, "i"));

      const recovery = await recoveryState(value.directory);
      assert.equal(recovery.metadata.length, 1);
      const metadata = JSON.parse(await readFile(path.join(value.directory, recovery.metadata[0]), "utf8"));
      assert.match(JSON.stringify(metadata), /EACCES/);
      for (const [kind, expected] of [["output", oldOutput], ["manifest", oldManifest]]) {
        const basename = metadata.artifacts[kind].backupBasename;
        const bytes = await readFile(path.join(value.directory, basename));
        assert.equal(sha256(bytes), sha256(expected));
        assert.equal(metadata.artifacts[kind].sha256, sha256(expected));
        assert.equal(metadata.artifacts[kind].size, expected.length);
      }
    } finally { await rm(value.directory, { recursive: true, force: true }); }
  });
}

test("backup cleanup failure never rolls back or deletes the fully committed new pair", async () => {
  const value = await fixture();
  try {
    await writeFile(value.outputPath, "old movie");
    await writeFile(value.manifestPath, '{"version":1,"kind":"old"}\n');
    const error = await capturedRejection(renderTest.publishArtifactPair(value, {
      beforeBackupCleanup(kind) {
        if (kind === "output") throw accessError("output backup cleanup");
      },
    }));
    assert.match(error.message, /cleanup|EACCES/i);
    assert.equal(await readFile(value.outputPath, "utf8"), "new movie");
    assert.deepEqual(JSON.parse(await readFile(value.manifestPath, "utf8")), value.manifest);
    assert.ok((await recoveryState(value.directory)).backups.length >= 1);
  } finally { await rm(value.directory, { recursive: true, force: true }); }
});

test("ordinary rollback fully restores the old pair and removes recovery state", async () => {
  const value = await fixture();
  try {
    await writeFile(value.outputPath, "old movie");
    await writeFile(value.manifestPath, '{"version":1,"kind":"old"}\n');
    await assert.rejects(renderTest.publishArtifactPair(value, {
      beforeManifestCommit() { throw new Error("manifest commit failed"); },
    }), /manifest commit failed/);
    assert.equal(await readFile(value.outputPath, "utf8"), "old movie");
    assert.equal(await readFile(value.manifestPath, "utf8"), '{"version":1,"kind":"old"}\n');
    assert.deepEqual(await recoveryState(value.directory), { backups: [], metadata: [] });
  } finally { await rm(value.directory, { recursive: true, force: true }); }
});

test("successful replacement removes all recovery state", async () => {
  const value = await fixture();
  try {
    await writeFile(value.outputPath, "old movie");
    await writeFile(value.manifestPath, '{"version":1,"kind":"old"}\n');
    await renderTest.publishArtifactPair(value);
    assert.equal(await readFile(value.outputPath, "utf8"), "new movie");
    assert.deepEqual(JSON.parse(await readFile(value.manifestPath, "utf8")), value.manifest);
    assert.deepEqual(await recoveryState(value.directory), { backups: [], metadata: [] });
  } finally { await rm(value.directory, { recursive: true, force: true }); }
});

for (const oldState of ["output-only", "manifest-only"]) {
  test(`pre-existing ${oldState} split artifact is rejected without changing or deleting it`, async () => {
    const value = await fixture();
    const target = oldState === "output-only" ? value.outputPath : value.manifestPath;
    const bytes = Buffer.from(`unique ${oldState} bytes`);
    try {
      await writeFile(target, bytes);
      await assert.rejects(renderTest.publishArtifactPair(value), /MP4|manifest|pair|閰嶅/i);
      assert.deepEqual(await readFile(target), bytes);
      assert.deepEqual(await recoveryState(value.directory), { backups: [], metadata: [] });
    } finally { await rm(value.directory, { recursive: true, force: true }); }
  });
}

test("successful pair publication fsyncs temps and replaces both artifacts", async () => {
  const value = await fixture();
  try {
    await renderTest.publishArtifactPair(value);
    assert.equal(await readFile(value.outputPath, "utf8"), "new movie");
    assert.deepEqual(JSON.parse(await readFile(value.manifestPath, "utf8")), value.manifest);
    assert.deepEqual(await residues(value.directory), []);
  } finally { await rm(value.directory, { recursive: true, force: true }); }
});

test("descriptor piping handles backpressure and closes the input fd after success", { timeout: 30_000 }, async () => {
  const value = await fixture();
  const pcm = path.join(value.directory, "large.pcm");
  try {
    await writeFile(pcm, Buffer.alloc(8 * 1024 * 1024, 1));
    const record = await renderTest.openGeneratedMedia(pcm, "large pcm", "audio");
    await renderTest.runFfmpegFromHandles(["-f", "s16le", "-ar", "48000", "-ac", "1", "-i", "pipe:3", "-f", "null", "-"], [record]);
    await assert.rejects(record.handle.stat(), /closed|EBADF|filehandle/i);
  } finally { await rm(value.directory, { recursive: true, force: true }); }
});

test("pipe hash interruption and child early exit both fail closed and close fds", { timeout: 30_000 }, async () => {
  const value = await fixture();
  const pcm = path.join(value.directory, "input.pcm");
  try {
    await writeFile(pcm, Buffer.alloc(2 * 1024 * 1024, 2));
    const interrupted = await renderTest.openGeneratedMedia(pcm, "interrupted pcm", "audio");
    interrupted.expectedBytes += 1;
    await assert.rejects(renderTest.runFfmpegFromHandles(["-f", "s16le", "-ar", "48000", "-ac", "1", "-i", "pipe:3", "-f", "null", "-"], [interrupted]), /输送|字节|SHA-256/);
    await assert.rejects(interrupted.handle.stat(), /closed|EBADF|filehandle/i);

    const early = await renderTest.openGeneratedMedia(pcm, "early-exit pcm", "audio");
    await assert.rejects(renderTest.runFfmpegFromHandles(["-version"], [early]), /管道|提前|EPIPE|closed/i);
    await assert.rejects(early.handle.stat(), /closed|EBADF|filehandle/i);
  } finally { await rm(value.directory, { recursive: true, force: true }); }
});

test("abort kills ffmpeg piping and closes the descriptor", { timeout: 30_000 }, async () => {
  const value = await fixture();
  const pcm = path.join(value.directory, "abort.pcm");
  try {
    await writeFile(pcm, Buffer.alloc(16 * 1024 * 1024, 3));
    const record = await renderTest.openGeneratedMedia(pcm, "abort pcm", "audio");
    const controller = new AbortController();
    const running = renderTest.runFfmpegFromHandles(["-re", "-f", "s16le", "-ar", "48000", "-ac", "1", "-i", "pipe:3", "-f", "null", "-"], [record], { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(running, /中止/);
    await assert.rejects(record.handle.stat(), /closed|EBADF|filehandle/i);
  } finally { await rm(value.directory, { recursive: true, force: true }); }
});
