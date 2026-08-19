const SHOT_PATTERN = [
  { shotType: "环境远景", camera: "固定建立空间，结尾轻微推进" },
  { shotType: "人物中景", camera: "沿人物视线缓慢横移" },
  { shotType: "动作近景", camera: "克制跟随主体动作" },
  { shotType: "人物特写", camera: "固定镜头，轻微推进强调情绪" },
  { shotType: "物件细节特写", camera: "固定细节镜头，动作完成后切出" },
  { shotType: "关系双人中景", camera: "稳定构图，以反应动作承接剪辑" },
  { shotType: "主观视线镜头", camera: "视线匹配切换，缓慢靠近视觉重点" },
  { shotType: "反应近景", camera: "固定镜头，保留短暂停顿" },
];

function visibleLength(value) {
  return String(value || "").replace(/\s/g, "").length;
}

function splitLongSentence(sentence, targetCharacters = 16) {
  const source = String(sentence || "").trim();
  if (!source) return [];
  if (visibleLength(source) <= targetCharacters + 6) return [source];
  const chunks = [];
  let remaining = source;
  while (visibleLength(remaining) > targetCharacters + 6) {
    const candidates = [];
    for (let index = 0; index < remaining.length; index += 1) {
      if (/[，、；：,;:]/.test(remaining[index])) candidates.push(index + 1);
    }
    const preferred = candidates
      .filter((index) => index >= Math.max(6, targetCharacters - 7) && index <= targetCharacters + 7)
      .sort((a, b) => Math.abs(a - targetCharacters) - Math.abs(b - targetCharacters))[0];
    const cut = preferred || Math.min(remaining.length, targetCharacters);
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks.filter(Boolean);
}

export function splitScriptIntoCinematicBeats(text, options = {}) {
  const paceTarget = options.pace === "舒缓" ? 20 : options.pace === "紧凑" ? 13 : 16;
  const targetCharacters = Math.max(10, Math.min(24, Number(options.targetCharacters) || paceTarget));
  return String(text || "")
    .split(/(?<=[。！？!?])/)
    .flatMap((sentence) => splitLongSentence(sentence, targetCharacters))
    .filter(Boolean);
}

export function cinematicShotPlan(index) {
  return { ...SHOT_PATTERN[Math.abs(Number(index) || 0) % SHOT_PATTERN.length] };
}

export function cinematicDuration(narration, options = {}) {
  const text = String(narration || "");
  const punctuationPause = (text.match(/[，、,]/g) || []).length * 0.16
    + (text.match(/[；：;:]/g) || []).length * 0.28
    + (text.match(/[。！？!?]/g) || []).length * 0.38;
  const shotType = String(options.shotType || "");
  const languageTime = visibleLength(text) / 4.2 + punctuationPause;
  const narrativeHold = /环境|远景|全景/.test(shotType) ? 0.65 : /人物特写/.test(shotType) ? 0.35 : /细节|反应|视线/.test(shotType) ? -0.25 : 0;
  const paceFactor = options.pace === "舒缓" ? 1.14 : options.pace === "紧凑" ? 0.9 : 1;
  const seconds = (languageTime + narrativeHold) * paceFactor;
  return Math.round(Math.max(2.2, Math.min(5.5, seconds)) * 10) / 10;
}

export function validateCinematicCoverage(script, beats) {
  const normalize = (value) => String(value || "").normalize("NFKC").replace(/\s+/g, "");
  return normalize(script) === normalize((beats || []).join(""));
}
