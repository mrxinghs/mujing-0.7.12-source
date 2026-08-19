const fs = require("node:fs");
const path = require("node:path");
const { app, safeStorage } = require("electron");

const settingsFile = process.env.MUJING_DIAGNOSTIC_SETTINGS;
if (settingsFile && path.isAbsolute(settingsFile)) app.setPath("userData", path.dirname(settingsFile));

function safeIdentifier(value, maximum = 500) {
  const text = typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  return text && text.length <= maximum && /^[A-Za-z0-9_.:/-]+$/.test(text) ? text : "";
}

function report(value) {
  const output = process.env.MUJING_DIAGNOSTIC_OUTPUT;
  const text = `${JSON.stringify(value)}\n`;
  if (output && path.isAbsolute(output)) fs.writeFileSync(output, text, { encoding: "utf8", mode: 0o600 });
  else process.stdout.write(text);
}

app.whenReady().then(async () => {
  let stage = "startup";
  try {
    stage = "settings";
    const settings = JSON.parse(safeStorage.decryptString(fs.readFileSync(settingsFile)));
    const provider = settings?.custom || {};
    const apiKey = String(provider.apiKey || "").trim();
    const baseUrl = String(provider.baseUrl || "https://ark.cn-beijing.volces.com/api/v3").replace(/\/+$/, "");
    const videoModel = String(provider.videoModel || "").trim();
    if (!apiKey || !videoModel) throw new Error("saved Seedance API key or model missing");
    stage = "models_get";
    const response = await fetch(`${baseUrl}/models`, { method: "GET", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" } });
    const bodyText = (await response.text()).slice(0, 2 * 1024 * 1024);
    let body = {};
    try { body = JSON.parse(bodyText); } catch { /* Only structured fields are reported. */ }
    const modelIds = Array.isArray(body?.data) ? body.data.map((item) => safeIdentifier(item?.id)).filter(Boolean).slice(0, 500) : [];
    report({
      baseUrl,
      videoModel: safeIdentifier(videoModel),
      modelKind: /^ep-/i.test(videoModel) ? "endpoint" : "model",
      status: response.status,
      ok: response.ok,
      modelVisible: modelIds.includes(videoModel),
      modelCount: modelIds.length,
      code: safeIdentifier(body?.error?.code ?? body?.code ?? body?.error_code),
      requestId: safeIdentifier(response.headers.get("x-request-id") || response.headers.get("x-tt-logid") || body?.request_id, 200),
    });
  } catch (error) {
    report({ diagnosticError: safeIdentifier(error?.code) || "local_diagnostic_failed", stage });
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
