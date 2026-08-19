const MAX_PROJECT_PACKAGE_CHARACTERS = 25 * 1024 * 1024;

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

export function parseProjectPackageText(text, options = {}) {
  const source = String(text || "");
  const maxCharacters = Number(options.maxCharacters) || MAX_PROJECT_PACKAGE_CHARACTERS;
  const maxShots = Number(options.maxShots) || 1_000;
  if (!source.trim()) throw new Error("项目制作包是空文件。");
  if (source.length > maxCharacters) throw new Error("项目制作包超过 25 MB，已停止导入。");
  let project;
  try { project = JSON.parse(source); }
  catch { throw new Error("无法读取项目制作包：文件不是有效的 JSON。"); }
  if (!plainObject(project)) throw new Error("项目制作包结构无效。");
  const version = Number(project.version || 1);
  if (!Number.isInteger(version) || version < 1 || version > 12) throw new Error("项目制作包版本不受支持，请使用幕境导出的 .story.json 文件。");
  if (typeof project.script !== "string" || project.script.length > 1_000_000) throw new Error("项目制作包缺少有效的解说文稿。");
  if (!Array.isArray(project.shots) || project.shots.length > maxShots) throw new Error("项目制作包的分镜数量无效或过多。");
  for (const shot of project.shots) {
    if (!plainObject(shot) || typeof shot.narration !== "string") throw new Error("项目制作包中存在无效分镜。");
    const duration = Number(shot.duration);
    if (!Number.isFinite(duration) || duration <= 0 || duration > 3_600) throw new Error("项目制作包中存在无效镜头时长。");
  }
  return project;
}

export function importedPackageSummary(project) {
  return {
    name: String(project?.projectName || "未命名项目").slice(0, 80),
    shots: Array.isArray(project?.shots) ? project.shots.length : 0,
    hasVoice: Boolean(project?.voiceUrl),
    hasMusic: Boolean(project?.musicUrl),
  };
}
