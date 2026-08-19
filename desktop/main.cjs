const { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { startLocalServer } = require("./local-server.cjs");
const providers = require("./providers.cjs");
const { createPaidTaskJournal, createPaidTaskManager } = require("./paid-task-journal.cjs");
const { createPaidResubmitAuthorizer } = require("./paid-resubmit-authorization.cjs");
const settingsStore = require("./settings-store.cjs");
const { renderVideo, validateCompleteRenderPayload } = require("./render.cjs");
const { resolveE2EExportPath } = require("./e2e-gate.cjs");
const { saveImageDataUrl } = require("./media-save-data-url.cjs");
const { persistVoiceProvenance } = require("./media-provenance.cjs");

let mainWindow = null;
let localServer = null;
let localUrl = "";
let mediaDir = "";
let paidTaskManager = null;

const defaultSettings = settingsStore.DEFAULT_SETTINGS;

function settingsPath() {
  return path.join(app.getPath("userData"), "provider-settings.bin");
}

function paidTaskJournalPath() {
  return path.join(app.getPath("userData"), "paid-video-tasks.json");
}

function paidTaskIdentitySecretPath() {
  return path.join(app.getPath("userData"), "paid-task-identity.secret");
}

function readSettings() {
  try {
    const encrypted = fs.readFileSync(settingsPath());
    const parsed = JSON.parse(safeStorage.decryptString(encrypted));
    return settingsStore.normalizeStoredSettings(parsed);
  } catch { return structuredClone(defaultSettings); }
}

function writeSettings(settings) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("当前系统暂时无法安全保存密钥，请重启电脑后再试。");
  const safe = settingsStore.mergeSettingsUpdate(readSettings(), settings);
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), safeStorage.encryptString(JSON.stringify(safe)));
  return settingsStore.publicSettings(safe);
}

function configFor(providerName, settings = readSettings()) {
  if (String(providerName || "") === "本地 ComfyUI") return settings.comfyui;
  if (/OpenAI/i.test(String(providerName || ""))) return settings.openai;
  if (/ElevenLabs/i.test(String(providerName || ""))) return { ...settings.elevenlabs, kind: "elevenlabs" };
  return { ...settings.custom, baseUrl: settings.custom.baseUrl || "https://ark.cn-beijing.volces.com/api/v3" };
}

function mediaUrl(filename) {
  return `${localUrl}__media/${encodeURIComponent(path.basename(filename))}`;
}

function sendAssetProgress(event, payload, kind, status) {
  if (!event.sender.isDestroyed()) event.sender.send("ai:asset-progress", { shotId: payload?.shotId, jobId: payload?.jobId, kind, status });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1040,
    minHeight: 700,
    show: false,
    backgroundColor: "#f4f5f1",
    title: "幕境 · AI 视频创作工作台",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(localUrl)) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(localUrl)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });
  void mainWindow.loadURL(localUrl);
}

app.whenReady().then(async () => {
  try {
    const runtimeRoot = app.isPackaged ? path.join(process.resourcesPath, "app.asar.unpacked") : app.getAppPath();
    mediaDir = path.join(app.getPath("userData"), "media");
    fs.mkdirSync(mediaDir, { recursive: true });
    paidTaskManager = createPaidTaskManager({
      journal: createPaidTaskJournal(paidTaskJournalPath(), { identitySecretPath: paidTaskIdentitySecretPath() }),
      resubmitAuthorizer: createPaidResubmitAuthorizer({ ttlMs: 90_000 }),
      preflightTask: providers.preflightVideoTask,
      submitTask: providers.submitVideoTask,
      pollTask: providers.pollVideoTask,
    });
    const started = await startLocalServer(runtimeRoot, mediaDir);
    localServer = started.server;
    localUrl = started.url;
    ipcMain.handle("app:version", () => app.getVersion());
    ipcMain.handle("settings:get", () => settingsStore.publicSettings(readSettings()));
    ipcMain.handle("storage:info", () => ({ userDataPath: app.getPath("userData"), mediaPath: mediaDir, settingsFile: settingsPath(), paidTaskJournalFile: paidTaskJournalPath() }));
    ipcMain.handle("settings:save", (_event, settings) => {
      if (settings?.mode === "live" && String(settings?.custom?.videoModel || "").trim()) providers.validateSeedanceModelId(settings?.custom?.videoModel);
      return writeSettings(settings);
    });
    ipcMain.handle("settings:test", async (_event, settings) => {
      const config = settingsStore.resolveTestConfig(readSettings(), settings, settings?.section);
      if (settings?.section === "elevenlabs") return providers.testElevenLabsConnection(config);
      if (settings?.section === "comfyui") return providers.testComfyUIConnection(config);
      if (settings?.section === "custom") return providers.testSeedanceConnection(config);
      return providers.testConnection(config);
    });
    ipcMain.handle("settings:choose-comfy-workflow", async () => {
      const choice = await dialog.showOpenDialog(mainWindow, { title: "选择 ComfyUI API 工作流", properties: ["openFile"], filters: [{ name: "ComfyUI API 工作流", extensions: ["json"] }] });
      if (choice.canceled || !choice.filePaths[0]) return { canceled: true };
      const source = choice.filePaths[0];
      if (fs.statSync(source).size > 2 * 1024 * 1024) throw new Error("工作流超过 2MB，已阻止导入。");
      const workflowDir = path.join(app.getPath("userData"), "comfyui-workflows");
      fs.mkdirSync(workflowDir, { recursive: true });
      const destination = path.join(workflowDir, `workflow-${Date.now()}.json`);
      fs.copyFileSync(source, destination);
      providers.readWorkflow({ workflowPath: destination });
      return { canceled: false, path: destination, name: path.basename(source) };
    });
    ipcMain.handle("ai:character-profile", async (_event, payload) => providers.createCharacterProfile(configFor(payload?.provider), payload));
    ipcMain.handle("ai:storyboard", async (_event, payload) => providers.createStoryboard(configFor(payload?.provider), payload));
    ipcMain.handle("ai:optimize-image-prompt", async (_event, payload) => providers.optimizeImagePrompt(configFor(payload?.provider), payload));
    ipcMain.handle("ai:optimize-video-prompt", async (_event, payload) => providers.optimizeVideoPrompt(configFor(payload?.provider), payload));
    ipcMain.handle("ai:analyze-style-reference", async (_event, payload) => providers.analyzeStyleReference(configFor(payload?.provider), payload, mediaDir));
    ipcMain.handle("ai:image", async (event, payload) => {
      const result = await providers.createImage(configFor(payload?.provider), payload, mediaDir, (status) => sendAssetProgress(event, payload, "image", status));
      return { ...result, url: mediaUrl(result.filename) };
    });
    ipcMain.handle("ai:video-submit", async (_event, payload) => {
      if (String(payload?.provider || "") === "本地 ComfyUI") return providers.submitComfyUIVideoTask(configFor(payload.provider), payload, mediaDir);
      const result = await paidTaskManager.submit(configFor(payload?.provider), payload, mediaDir);
      const entry = paidTaskManager.list(payload?.projectId).find((item) => item.taskId === result.jobId);
      if (!String(entry?.provider || "").trim()) throw new Error("付费任务记录缺少原服务商，已阻止返回不完整的任务身份。");
      return { ...result, provider: entry.provider };
    });
    ipcMain.handle("ai:video-request-resubmit-authorization", async (event, payload) => paidTaskManager.requestResubmitAuthorization(
      configFor(payload?.provider),
      payload,
      mediaDir,
      {
        senderId: event.sender.id,
        confirm: async (notice) => {
          const choice = await dialog.showMessageBox(mainWindow, {
            type: "warning",
            title: notice.title,
            message: notice.message,
            detail: "只有点击“确认放弃并付费重提”才会签发一次性授权；取消不会发送付费请求。",
            buttons: ["取消", "确认放弃并付费重提"],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
          });
          return choice.response === 1;
        },
      },
    ));
    ipcMain.handle("ai:video-resubmit", async (event, payload) => {
      const result = await paidTaskManager.resubmit(configFor(payload?.provider), payload, mediaDir, {
        senderId: event.sender.id,
        token: payload?.authorizationToken,
      });
      const entry = paidTaskManager.list(payload?.projectId).find((item) => item.taskId === result.jobId);
      if (!String(entry?.provider || "").trim()) throw new Error("付费任务记录缺少原服务商，已阻止返回不完整的任务身份。");
      return { ...result, provider: entry.provider };
    });
    ipcMain.handle("ai:video-journal", async (_event, payload) => paidTaskManager.list(payload?.projectId));
    ipcMain.handle("ai:video-abandon", async (_event, payload) => {
      const entries = paidTaskManager.list(payload?.projectId).filter((entry) => entry.shotId === String(payload?.shotId || "")
        && !["rejected", "failed", "canceled", "abandoned"].includes(entry.status)
        && !(entry.status === "completed" && entry.localResultSavedAt));
      if (!entries.length) return { abandoned: false, count: 0, remoteMayContinue: false };
      const remoteMayContinue = entries.some((entry) => Boolean(entry.taskId) || ["submission_pending", "unknown"].includes(entry.status));
      const choice = await dialog.showMessageBox(mainWindow, {
        type: "warning",
        title: "放弃等待并解除编辑锁",
        message: `镜头 ${String(payload?.shotId || "")} 的本地等待将被放弃，随后可以继续修改角色、分镜和首图。`,
        detail: remoteMayContinue
          ? "这不会向服务商发送取消请求。Seedance 远端任务可能继续运行并计费；幕境会保留原任务 ID 和审计记录，但不再自动恢复或等待它。"
          : "幕境会保留原请求的审计记录，但不再自动恢复或等待它。",
        buttons: ["返回", "确认放弃并解除锁定"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (choice.response !== 1) return { abandoned: false, count: 0, remoteMayContinue };
      return paidTaskManager.abandon(payload);
    });
    ipcMain.handle("ai:video-poll", async (event, payload) => {
      if (String(payload?.provider || "") === "本地 ComfyUI") {
        const result = await providers.pollComfyUIVideoTask(configFor(payload.provider), payload, mediaDir, (status) => sendAssetProgress(event, payload, "video", status));
        return result.filename ? { ...result, url: mediaUrl(result.filename) } : result;
      }
      const taskPair = paidTaskManager.resolveTaskPair(payload);
      const result = await paidTaskManager.poll(configFor(taskPair.provider), { ...payload, jobId: taskPair.jobId, provider: taskPair.provider }, mediaDir, (status) => sendAssetProgress(event, payload, "video", status));
      if (!result.filename) return result;
      return { ...result, url: mediaUrl(result.filename) };
    });
    ipcMain.handle("ai:video-cancel", async (_event, payload) => {
      if (String(payload?.provider || "") !== "本地 ComfyUI") return { status: "unsupported" };
      return providers.cancelComfyUIVideoTask(configFor(payload.provider), payload);
    });
    ipcMain.handle("ai:speech", async (_event, payload) => {
      const result = await providers.createSpeech(configFor(payload?.provider), payload, mediaDir);
      const provenance = await persistVoiceProvenance({ mediaDir, filename: result.filename, script: payload?.text, source: "provider-speech" });
      return { ...result, url: mediaUrl(result.filename), provenance: { mediaId: provenance.mediaId, scriptSha256: provenance.scriptSha256, duration: provenance.duration, source: provenance.source } };
    });
    ipcMain.handle("ai:demo-speech", async (_event, payload) => {
      const result = await providers.createDemoSpeech(payload, mediaDir);
      const provenance = await persistVoiceProvenance({ mediaDir, filename: result.filename, script: payload?.text, source: result.source || "local-demo-speech" });
      return { ...result, url: mediaUrl(result.filename), provenance: { mediaId: provenance.mediaId, scriptSha256: provenance.scriptSha256, duration: provenance.duration, source: provenance.source } };
    });
    ipcMain.handle("media:save-data-url", (_event, payload) => {
      const { filename } = saveImageDataUrl(payload, mediaDir, { writeMedia: providers.writeMedia });
      return { filename, url: mediaUrl(filename) };
    });
    ipcMain.handle("media:choose-music", async () => {
      const choice = await dialog.showOpenDialog(mainWindow, {
        title: "选择或替换背景音乐",
        properties: ["openFile"],
        filters: [{ name: "音频文件", extensions: ["mp3", "wav", "m4a", "aac", "ogg", "flac"] }],
      });
      if (choice.canceled || !choice.filePaths[0]) return { canceled: true };
      const source = choice.filePaths[0];
      const extension = path.extname(source).slice(1).toLowerCase();
      if (!["mp3", "wav", "m4a", "aac", "ogg", "flac"].includes(extension)) throw new Error("请选择 MP3、WAV、M4A、AAC、OGG 或 FLAC 音乐文件。");
      const filename = `background-music-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extension}`;
      fs.copyFileSync(source, path.join(mediaDir, filename));
      return { canceled: false, name: path.basename(source), filename, url: mediaUrl(filename) };
    });
    ipcMain.handle("project:export-video", async (_event, payload) => {
      validateCompleteRenderPayload(payload);
      const safeName = String(payload?.projectName || "幕境作品").replace(/[<>:"/\\|?*]/g, "-").slice(0, 80);
      const e2eOutputPath = resolveE2EExportPath({ isPackaged: app.isPackaged, enabled: process.env.MUJING_E2E, outputPath: process.env.MUJING_E2E_EXPORT_PATH });
      const choice = e2eOutputPath
        ? { canceled: false, filePath: e2eOutputPath }
        : await dialog.showSaveDialog(mainWindow, { title: "导出完整视频", defaultPath: `${safeName}.mp4`, filters: [{ name: "MP4 视频", extensions: ["mp4"] }] });
      if (choice.canceled || !choice.filePath) return { canceled: true };
      return renderVideo(payload, mediaDir, choice.filePath);
    });
    createWindow();
  } catch (error) {
    dialog.showErrorBox("幕境无法启动", error instanceof Error ? error.message : String(error));
    app.quit();
  }
});

app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && localUrl) createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  localServer?.close();
});
