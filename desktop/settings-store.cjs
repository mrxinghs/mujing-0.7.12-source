const DEFAULT_SETTINGS = {
  mode: "demo",
  openai: {
    apiKey: "",
    baseUrl: "https://api.openai.com/v1",
    storyboardModel: "gpt-5.6",
    imageModel: "gpt-image-2",
    videoModel: "sora-2",
    voiceModel: "gpt-4o-mini-tts",
    voice: "coral",
  },
  custom: {
    apiKey: "",
    baseUrl: "",
    storyboardModel: "",
    imageModel: "",
    videoModel: "",
    voiceModel: "",
    voice: "",
  },
  elevenlabs: {
    apiKey: "",
    baseUrl: "https://api.elevenlabs.io/v1",
    storyboardModel: "",
    imageModel: "",
    videoModel: "",
    voiceModel: "eleven_v3",
    voice: "",
  },
  comfyui: {
    apiKey: "",
    baseUrl: "http://127.0.0.1:8188",
    storyboardModel: "",
    imageModel: "",
    videoModel: "wan2.2-ti2v-5b",
    voiceModel: "",
    voice: "",
    workflowPath: "",
    fps: "24",
    steps: "30",
  },
};

const PUBLIC_FIELDS = ["baseUrl", "storyboardModel", "imageModel", "videoModel", "voiceModel", "voice", "workflowPath", "fps", "steps"];

function normalizeStoredSettings(settings = {}) {
  const elevenlabs = { ...DEFAULT_SETTINGS.elevenlabs, ...(settings?.elevenlabs || {}) };
  if (elevenlabs.voiceModel === "eleven_multilingual_v2") elevenlabs.voiceModel = "eleven_v3";
  return {
    mode: settings?.mode === "live" ? "live" : "demo",
    openai: { ...DEFAULT_SETTINGS.openai, ...(settings?.openai || {}) },
    custom: { ...DEFAULT_SETTINGS.custom, ...(settings?.custom || {}) },
    elevenlabs,
    comfyui: { ...DEFAULT_SETTINGS.comfyui, ...(settings?.comfyui || {}) },
  };
}

function publicProvider(provider) {
  return {
    ...Object.fromEntries(PUBLIC_FIELDS.map((field) => [field, String(provider?.[field] || "")])),
    hasKey: Boolean(String(provider?.apiKey || "").trim()),
  };
}

function publicSettings(settings) {
  const normalized = normalizeStoredSettings(settings);
  return { mode: normalized.mode, openai: publicProvider(normalized.openai), custom: publicProvider(normalized.custom), elevenlabs: publicProvider(normalized.elevenlabs), comfyui: publicProvider(normalized.comfyui) };
}

function mergeProvider(stored, update = {}) {
  const merged = { ...stored };
  for (const field of PUBLIC_FIELDS) {
    if (Object.hasOwn(update, field)) merged[field] = String(update[field] ?? "");
  }
  if (update.clearApiKey === true) merged.apiKey = "";
  else if (String(update.apiKey || "").trim()) merged.apiKey = String(update.apiKey).trim();
  return merged;
}

function mergeSettingsUpdate(storedSettings, update = {}) {
  const stored = normalizeStoredSettings(storedSettings);
  return {
    mode: update?.mode === "live" ? "live" : update?.mode === "demo" ? "demo" : stored.mode,
    openai: mergeProvider(stored.openai, update?.openai),
    custom: mergeProvider(stored.custom, update?.custom),
    elevenlabs: mergeProvider(stored.elevenlabs, update?.elevenlabs),
    comfyui: mergeProvider(stored.comfyui, update?.comfyui),
  };
}

function resolveTestConfig(storedSettings, update, section = "openai") {
  const merged = mergeSettingsUpdate(storedSettings, update);
  return merged[section === "custom" ? "custom" : section === "elevenlabs" ? "elevenlabs" : section === "comfyui" ? "comfyui" : "openai"];
}

module.exports = { DEFAULT_SETTINGS, mergeSettingsUpdate, normalizeStoredSettings, publicSettings, resolveTestConfig };
