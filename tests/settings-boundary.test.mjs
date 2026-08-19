import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

test("settings:get public shape never contains saved API key material", () => {
  const { publicSettings } = require("../desktop/settings-store.cjs");
  const stored = {
    mode: "live",
    openai: { apiKey: "sk-saved-secret", baseUrl: "https://api.example/v1", videoModel: "video" },
    custom: { apiKey: "custom-saved-secret", baseUrl: "https://custom.example/v1" },
    elevenlabs: { apiKey: "xi-saved-secret", baseUrl: "https://api.elevenlabs.io/v1", voice: "voice-id" },
  };
  const exposed = publicSettings(stored);
  assert.equal(exposed.openai.hasKey, true);
  assert.equal(exposed.custom.hasKey, true);
  assert.equal(exposed.elevenlabs.hasKey, true);
  assert.equal("apiKey" in exposed.openai, false);
  assert.equal("apiKey" in exposed.custom, false);
  assert.equal("apiKey" in exposed.elevenlabs, false);
  assert.doesNotMatch(JSON.stringify(exposed), /sk-saved-secret|custom-saved-secret|xi-saved-secret/);
});

test("blank saves and tests retain the old key; explicit clear alone deletes it", () => {
  const { mergeSettingsUpdate, resolveTestConfig } = require("../desktop/settings-store.cjs");
  const stored = {
    mode: "live",
    openai: { apiKey: "sk-old", baseUrl: "https://old.example/v1", videoModel: "old-video" },
    custom: { apiKey: "custom-old", baseUrl: "https://custom.example/v1" },
    elevenlabs: { apiKey: "xi-old", baseUrl: "https://api.elevenlabs.io/v1" },
  };

  const blank = { mode: "live", openai: { apiKey: "", baseUrl: "https://new.example/v1", videoModel: "new-video" }, custom: { apiKey: "" }, elevenlabs: { apiKey: "", voice: "new-voice" } };
  const merged = mergeSettingsUpdate(stored, blank);
  assert.equal(merged.openai.apiKey, "sk-old");
  assert.equal(merged.custom.apiKey, "custom-old");
  assert.equal(merged.elevenlabs.apiKey, "xi-old");
  assert.equal(merged.elevenlabs.voice, "new-voice");
  assert.equal(resolveTestConfig(stored, blank, "openai").apiKey, "sk-old");
  assert.equal(resolveTestConfig(stored, blank, "elevenlabs").apiKey, "xi-old");

  const cleared = mergeSettingsUpdate(stored, { openai: { apiKey: "", clearApiKey: true } });
  assert.equal(cleared.openai.apiKey, "");
  assert.equal(mergeSettingsUpdate(stored, { openai: { apiKey: "sk-new" } }).openai.apiKey, "sk-new");
});

test("Seedance 2.5 model or Endpoint values are preserved exactly instead of silently downgraded", () => {
  const { mergeSettingsUpdate, normalizeStoredSettings } = require("../desktop/settings-store.cjs");
  const guessedModel = normalizeStoredSettings({ custom: { videoModel: "doubao-seedance-2-5-260628" } });
  assert.equal(guessedModel.custom.videoModel, "doubao-seedance-2-5-260628");
  const endpoint = mergeSettingsUpdate(guessedModel, { custom: { videoModel: "ep-20260816-seedance25" } });
  assert.equal(endpoint.custom.videoModel, "ep-20260816-seedance25");
});
