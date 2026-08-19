import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const providers = require("../desktop/providers.cjs");

test("ElevenLabs connection validates the configured Voice ID without generating billable speech", async () => {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers });
    return new Response(JSON.stringify({ voice_id: "JBFqnCBsd6RMkjVDRZzb", name: "George" }), { status: 200 });
  };
  try {
    const result = await providers.testElevenLabsConnection({ apiKey: "xi-secret", baseUrl: "https://api.elevenlabs.io/v1", voiceModel: "eleven_v3", voice: "JBFqnCBsd6RMkjVDRZzb" });
    assert.deepEqual(result, { ok: true, voiceId: "JBFqnCBsd6RMkjVDRZzb", model: "eleven_v3" });
    assert.equal(calls[0].url, "https://api.elevenlabs.io/v1/voices/JBFqnCBsd6RMkjVDRZzb?with_settings=false");
    assert.equal(calls[0].headers["Content-Type"], "application/json");
    assert.equal(calls[0].headers["xi-api-key"], "xi-secret");
    assert.equal("Authorization" in calls[0].headers, false);
    assert.equal(calls.length, 1);
  } finally { global.fetch = originalFetch; }
});

test("ElevenLabs connection requires a Voice ID locally and maps safe provider details to an actionable error", async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls += 1; return new Response("{}", { status: 500 }); };
  try {
    await assert.rejects(
      providers.testElevenLabsConnection({ apiKey: "xi-secret", baseUrl: "https://api.elevenlabs.io/v1", voiceModel: "eleven_v3", voice: "" }),
      /ElevenLabs Voice ID不能为空/,
    );
    assert.equal(calls, 0);
  } finally { global.fetch = originalFetch; }

  global.fetch = async () => new Response(JSON.stringify({ detail: { status: "voice_not_found", message: "untrusted provider text" } }), {
    status: 400,
    headers: { "x-request-id": "safe-request-123" },
  });
  try {
    await assert.rejects(
      providers.testElevenLabsConnection({ apiKey: "xi-secret", baseUrl: "https://api.elevenlabs.io/v1", voiceModel: "eleven_v3", voice: "missing-voice" }),
      (error) => /无法识别当前 Voice ID/.test(error.message)
        && /voice_not_found/.test(error.message)
        && /safe-request-123/.test(error.message)
        && !/untrusted provider text/.test(error.message),
    );
  } finally { global.fetch = originalFetch; }
});

test("Eleven v3 speech reports an invalid saved key clearly and sends Chinese language metadata", async () => {
  const originalFetch = global.fetch;
  let requestBody;
  global.fetch = async (_url, init = {}) => {
    requestBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ detail: { status: "unauthorized", message: "provider text must stay hidden" } }), {
      status: 401,
      headers: { "x-request-id": "speech-request-123" },
    });
  };
  try {
    await assert.rejects(
      providers.createSpeech(
        { kind: "elevenlabs", apiKey: "expired-key", baseUrl: "https://api.elevenlabs.io/v1", voiceModel: "eleven_v3", voice: "JBFqnCBsd6RMkjVDRZzb" },
        { provider: "ElevenLabs", text: "你好，这是中文配音。" },
        "C:\\unused",
      ),
      (error) => /API Key 无效、已过期、被撤销或复制错误/.test(error.message)
        && /unauthorized/.test(error.message)
        && /speech-request-123/.test(error.message)
        && !/provider text must stay hidden/.test(error.message),
    );
    assert.equal(requestBody.model_id, "eleven_v3");
    assert.equal(requestBody.language_code, "zh");
  } finally { global.fetch = originalFetch; }
});

test("Eleven v3 rejects more than 5,000 characters before a paid speech request", async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls += 1; throw new Error("must not fetch"); };
  try {
    await assert.rejects(
      providers.createSpeech(
        { kind: "elevenlabs", apiKey: "key", baseUrl: "https://api.elevenlabs.io/v1", voiceModel: "eleven_v3", voice: "JBFqnCBsd6RMkjVDRZzb" },
        { provider: "ElevenLabs", text: "中".repeat(5_001) },
        "C:\\unused",
      ),
      /单次最多支持 5,000 个字符.*5,001 个字符/,
    );
    assert.equal(calls, 0);
  } finally { global.fetch = originalFetch; }
});

test("renderer exposes ElevenLabs routing, encrypted API settings, model and Voice ID", async () => {
  const { readFile } = await import("node:fs/promises");
  const [page, main, settings] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../desktop/main.cjs", import.meta.url), "utf8"),
    readFile(new URL("../desktop/settings-store.cjs", import.meta.url), "utf8"),
  ]);
  assert.match(page, /ElevenLabs API Key/);
  assert.match(page, /ElevenLabs Voice ID/);
  assert.match(page, /eleven_v3/);
  assert.match(main, /kind: "elevenlabs"/);
  assert.match(settings, /elevenlabs/);
});

test("legacy ElevenLabs default is migrated to Eleven v3", () => {
  const settingsStore = require("../desktop/settings-store.cjs");
  const normalized = settingsStore.normalizeStoredSettings({
    mode: "live",
    elevenlabs: { voiceModel: "eleven_multilingual_v2" },
  });
  assert.equal(normalized.elevenlabs.voiceModel, "eleven_v3");
});
