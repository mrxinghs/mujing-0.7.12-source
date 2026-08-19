const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mujingDesktop", {
  getAppVersion: () => ipcRenderer.invoke("app:version"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  getStorageInfo: () => ipcRenderer.invoke("storage:info"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  testConnection: (settings) => ipcRenderer.invoke("settings:test", settings),
  chooseComfyUIWorkflow: () => ipcRenderer.invoke("settings:choose-comfy-workflow"),
  createCharacterProfile: (payload) => ipcRenderer.invoke("ai:character-profile", payload),
  createStoryboard: (payload) => ipcRenderer.invoke("ai:storyboard", payload),
  optimizeImagePrompt: (payload) => ipcRenderer.invoke("ai:optimize-image-prompt", payload),
  optimizeVideoPrompt: (payload) => ipcRenderer.invoke("ai:optimize-video-prompt", payload),
  analyzeStyleReference: (payload) => ipcRenderer.invoke("ai:analyze-style-reference", payload),
  createImage: (payload) => ipcRenderer.invoke("ai:image", payload),
  submitVideoTask: (payload) => ipcRenderer.invoke("ai:video-submit", payload),
  requestVideoResubmitAuthorization: (payload) => ipcRenderer.invoke("ai:video-request-resubmit-authorization", payload),
  resubmitVideoTask: (payload) => ipcRenderer.invoke("ai:video-resubmit", payload),
  getPaidVideoTasks: (projectId) => ipcRenderer.invoke("ai:video-journal", { projectId }),
  abandonPaidVideoTask: (payload) => ipcRenderer.invoke("ai:video-abandon", payload),
  pollVideoTask: (payload) => ipcRenderer.invoke("ai:video-poll", payload),
  cancelVideoTask: (payload) => ipcRenderer.invoke("ai:video-cancel", payload),
  onAssetProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("ai:asset-progress", listener);
    return () => ipcRenderer.removeListener("ai:asset-progress", listener);
  },
  createSpeech: (payload) => ipcRenderer.invoke("ai:speech", payload),
  createDemoSpeech: (payload) => ipcRenderer.invoke("ai:demo-speech", payload),
  saveDataUrl: (payload) => ipcRenderer.invoke("media:save-data-url", payload),
  chooseMusic: () => ipcRenderer.invoke("media:choose-music"),
  exportVideo: (payload) => ipcRenderer.invoke("project:export-video", payload),
  isDesktop: true,
});
