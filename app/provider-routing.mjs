export const DEFAULT_PROVIDERS = Object.freeze({
  storyboard: "OpenAI",
  image: "Seedream",
  video: "Seedance",
  voice: "OpenAI Voice",
});

export function normalizeProviders(value) {
  const stored = value && typeof value === "object" ? value : {};
  return {
    storyboard: typeof stored.storyboard === "string" && stored.storyboard ? stored.storyboard : DEFAULT_PROVIDERS.storyboard,
    image: typeof stored.image === "string" && stored.image ? stored.image : DEFAULT_PROVIDERS.image,
    video: typeof stored.video === "string" && ["Seedance", "本地 ComfyUI"].includes(stored.video) ? stored.video : "Seedance",
    voice: typeof stored.voice === "string" && ["OpenAI Voice", "ElevenLabs", "火山语音"].includes(stored.voice) ? stored.voice : DEFAULT_PROVIDERS.voice,
  };
}
