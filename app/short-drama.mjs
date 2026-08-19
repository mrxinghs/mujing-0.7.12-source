const SCENE_HEADING = /^(?:场景|[内外]景|INT\.?|EXT\.?)\s*[：:]?\s*/i;
const DIALOGUE_LINE = /^([^：:\n]{1,20})[：:]\s*(.+)$/;
const NON_CHARACTER_SPEAKERS = /^(?:场景|时间|地点|动作|转场|音效|BGM|镜头|旁白|内心|独白|画外音|群众|众人|路人|员工们|宾客们|同学们)$/i;
const CROWD_PATTERN = /(群众演员|群众|众人|路人|行人|职员|员工们|宾客|婚礼宾客|记者群|保安|侍卫|学生们|同学们|村民|观众)/;

export const sampleShortDramaScript = `场景：创业公司会议室／白天

林夏推门走进会议室，所有职员突然安静。

林夏：这个项目，我不会退出。

周总慢慢放下手中的文件。

周总：你以为自己还有选择吗？

会议桌旁的员工们低声议论，林夏却忽然笑了。

林夏：有。因为真正的合同，在我手里。`;

function cleanLine(value) {
  return String(value || "").trim();
}

function cleanSpeaker(value) {
  return cleanLine(value).replace(/[\uff08(\u3010\u005b].*$/, "").trim();
}

export function isShortDramaSceneHeading(line) {
  return SCENE_HEADING.test(cleanLine(line));
}

export function shortDramaLineMetadata(line, inheritedScene = "") {
  const source = cleanLine(line);
  if (!source) return { kind: "action", scene: inheritedScene, speaker: "", dialogue: "", extras: "" };
  if (isShortDramaSceneHeading(source)) return { kind: "scene", scene: source.replace(SCENE_HEADING, "").trim() || source, speaker: "", dialogue: "", extras: "" };
  const match = source.match(DIALOGUE_LINE);
  const rawSpeaker = cleanSpeaker(match?.[1]);
  const speaker = rawSpeaker && !NON_CHARACTER_SPEAKERS.test(rawSpeaker) ? rawSpeaker : "";
  const dialogue = match && !/^(?:场景|时间|地点|动作|转场|音效|BGM|镜头)$/i.test(rawSpeaker) ? match[2].trim() : "";
  const crowd = source.match(CROWD_PATTERN)?.[1] || (/^(?:群众|众人|路人|员工们|宾客们)[：:]/.test(source) ? rawSpeaker : "");
  return { kind: dialogue ? "dialogue" : "action", scene: inheritedScene, speaker, dialogue, extras: crowd };
}

export function splitShortDramaBeats(text) {
  const lines = String(text || "").split(/\r?\n/).map(cleanLine).filter(Boolean);
  return lines.flatMap((line) => {
    if (isShortDramaSceneHeading(line) || DIALOGUE_LINE.test(line)) return [line];
    return line.split(/(?<=[。！？!?])/).map(cleanLine).filter(Boolean);
  });
}

export function extractShortDramaCharacters(text) {
  const names = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = cleanLine(line).match(DIALOGUE_LINE);
    const name = cleanSpeaker(match?.[1]);
    if (!name || NON_CHARACTER_SPEAKERS.test(name) || CROWD_PATTERN.test(name) || names.includes(name)) continue;
    names.push(name);
  }
  return names.slice(0, 10);
}

export function shortDramaShotPlan(index, metadata = {}) {
  if (metadata.kind === "scene") return { shotType: "场景建立全景", camera: "固定建立空间，结尾轻微推进" };
  if (metadata.kind === "dialogue") {
    const plans = [
      { shotType: "说话人近景", camera: "正面稳定跟拍，保留眼神与微表情" },
      { shotType: "过肩对话镜头", camera: "沿视线方向克制推进" },
      { shotType: "倾听者反应近景", camera: "固定镜头，保留台词后的情绪停顿" },
    ];
    return plans[Math.abs(Number(index) || 0) % plans.length];
  }
  return { shotType: "动作中近景", camera: "克制跟随主体动作，以视线或动作承接下一镜" };
}

export function shortDramaDuration(line, metadata = {}, pace = "自然") {
  if (metadata.kind === "scene") return pace === "紧凑" ? 2.2 : 2.8;
  const spoken = metadata.dialogue || line;
  const base = Math.max(1.8, Math.min(5.5, String(spoken || "").replace(/\s/g, "").length / 4.5 + (metadata.kind === "dialogue" ? 0.65 : 0.25)));
  const factor = pace === "舒缓" ? 1.12 : pace === "紧凑" ? 0.9 : 1;
  return Math.round(Math.max(1.8, Math.min(5.5, base * factor)) * 10) / 10;
}
