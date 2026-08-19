const fs = require("node:fs");
const path = require("node:path");
const { app, safeStorage } = require("electron");

const diagnosticSettingsFile = process.env.MUJING_DIAGNOSTIC_SETTINGS;
if (diagnosticSettingsFile && path.isAbsolute(diagnosticSettingsFile)) app.setPath("userData", path.dirname(diagnosticSettingsFile));

function report(value) {
  const output = process.env.MUJING_DIAGNOSTIC_OUTPUT;
  const text = `${JSON.stringify(value)}\n`;
  if (output && path.isAbsolute(output)) fs.writeFileSync(output, text, { encoding: "utf8", mode: 0o600 });
  else process.stdout.write(text);
}

function safeIdentifier(value, maximum = 200) {
  const text = typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  return text && text.length <= maximum && /^[A-Za-z0-9_.:/-]+$/.test(text) ? text : "";
}

async function inspect(url, apiKey) {
  const response = await fetch(url, { method: "GET", headers: { "xi-api-key": apiKey, "Content-Type": "application/json" } });
  const bodyText = (await response.text()).slice(0, 65_536);
  let body = {};
  try { body = JSON.parse(bodyText); } catch { /* Only structured fields are reported. */ }
  return {
    status: response.status,
    ok: response.ok,
    code: safeIdentifier(body?.error?.code ?? body?.error?.status ?? body?.detail?.code ?? body?.detail?.status ?? body?.code ?? body?.error_code),
    requestId: safeIdentifier(response.headers.get("x-request-id") || body?.request_id || body?.detail?.request_id),
    returnedVoiceIdMatches: typeof body?.voice_id === "string" ? body.voice_id === url.match(/\/voices\/([^?]+)/)?.[1] : undefined,
    modelIds: Array.isArray(body) ? body.map((item) => safeIdentifier(item?.model_id, 100)).filter(Boolean).slice(0, 50) : undefined,
  };
}

app.whenReady().then(async () => {
  let stage = "startup";
  try {
    const settingsFile = diagnosticSettingsFile;
    if (!settingsFile || !path.isAbsolute(settingsFile)) throw new Error("diagnostic settings path missing");
    stage = "read_settings";
    const encrypted = fs.readFileSync(settingsFile);
    stage = "decrypt_settings";
    const decrypted = safeStorage.decryptString(encrypted);
    stage = "parse_settings";
    const settings = JSON.parse(decrypted);
    const provider = settings?.elevenlabs || {};
    const apiKey = String(provider.apiKey || "").trim();
    const voiceId = String(provider.voice || "").trim();
    const baseUrl = String(provider.baseUrl || "https://api.elevenlabs.io/v1").replace(/\/+$/, "");
    if (!apiKey || !voiceId) throw new Error("saved ElevenLabs API key or Voice ID missing");
    stage = "provider_gets";
    const [voice, models] = await Promise.all([
      inspect(`${baseUrl}/voices/${encodeURIComponent(voiceId)}?with_settings=false`, apiKey),
      inspect(`${baseUrl}/models`, apiKey),
    ]);
    report({ voiceIdLength: voiceId.length, model: String(provider.voiceModel || ""), voice, models });
  } catch (error) {
    report({ diagnosticError: safeIdentifier(error?.code) || "local_diagnostic_failed", stage });
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
