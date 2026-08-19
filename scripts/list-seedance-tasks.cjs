const fs = require("node:fs");
const path = require("node:path");
const { app, safeStorage } = require("electron");

const settingsFile = process.env.MUJING_LIVE_SETTINGS;
if (settingsFile && path.isAbsolute(settingsFile)) app.setPath("userData", path.dirname(settingsFile));

function safe(value, maximum = 500) {
  const text = String(value || "").trim();
  return text.length <= maximum ? text : text.slice(0, maximum);
}

app.whenReady().then(async () => {
  try {
    const settings = JSON.parse(safeStorage.decryptString(fs.readFileSync(settingsFile)));
    const config = settings?.custom || {};
    const baseUrl = String(config.baseUrl || "https://ark.cn-beijing.volces.com/api/v3").replace(/\/+$/, "");
    const response = await fetch(`${baseUrl}/contents/generations/tasks?page_num=1&page_size=20`, {
      method: "GET",
      headers: { Authorization: `Bearer ${String(config.apiKey || "").trim()}`, "Content-Type": "application/json" },
    });
    const data = await response.json();
    const items = Array.isArray(data?.items) ? data.items : [];
    process.stdout.write(`${JSON.stringify({
      status: response.status,
      total: Number(data?.total || 0),
      items: items.slice(0, 20).map((item) => ({
        id: safe(item?.id), model: safe(item?.model), status: safe(item?.status),
        createdAt: Number(item?.created_at || 0), updatedAt: Number(item?.updated_at || 0),
        resolution: safe(item?.resolution), ratio: safe(item?.ratio), duration: safe(item?.duration),
        errorCode: safe(item?.error?.code),
      })),
    })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ error: safe(error?.message || error, 2_000) })}\n`);
  } finally { app.quit(); }
});
