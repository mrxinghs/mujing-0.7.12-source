import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const mediaTools = require("../desktop/media-tools.cjs");
const providers = require("../desktop/providers.cjs");
const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("macOS bundles extensionless ffmpeg and ffprobe executables", () => {
  assert.equal(mediaTools.bundledMediaExecutable("ffmpeg", { platform: "darwin", resourcesPath: "/Applications/幕境.app/Contents/Resources" }), "/Applications/幕境.app/Contents/Resources/ffmpeg");
  assert.equal(mediaTools.bundledMediaExecutable("ffprobe", { platform: "darwin", resourcesPath: "/Applications/幕境.app/Contents/Resources" }), "/Applications/幕境.app/Contents/Resources/ffprobe");
  assert.match(mediaTools.bundledMediaExecutable("ffmpeg", { platform: "win32", resourcesPath: "C:/app/resources" }), /ffmpeg\.exe$/);
});

test("macOS demo speech uses say and records a macOS source", () => {
  assert.deepEqual(providers.demoSpeechPlan("darwin", "/tmp/voice-demo.aiff"), {
    executable: "/usr/bin/say",
    args: ["-o", "/tmp/voice-demo.aiff", "--data-format=LEI16@22050"],
    extension: "aiff",
    source: "macos-say-demo",
  });
});

test("electron-builder defines Apple Silicon DMG and ZIP artifacts", () => {
  assert.deepEqual(pkg.build.mac.target, [
    { target: "dmg", arch: ["arm64"] },
    { target: "zip", arch: ["arm64"] },
  ]);
  assert.equal(pkg.build.mac.category, "public.app-category.video");
  assert.equal(pkg.build.mac.identity, null);
  assert.match(pkg.build.mac.artifactName, /Apple-Silicon-arm64/);
  assert.ok(pkg.build.mac.extraResources.some((entry) => entry.to === "ffmpeg"));
  assert.ok(pkg.build.mac.extraResources.some((entry) => entry.to === "ffprobe"));
});
