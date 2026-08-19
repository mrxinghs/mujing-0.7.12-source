export const PRODUCTION_ASSET_CATEGORIES = ["costume", "scene", "prop"];

const CATEGORY_LABELS = {
  costume: "服装",
  scene: "场景",
  prop: "道具",
};

const PROP_PATTERNS = [
  ["雨伞", /雨伞|伞下|撑伞/],
  ["手机", /手机|电话|通话|屏幕/],
  ["信件", /信件|信封|书信/],
  ["文件", /文件|资料|档案|合同/],
  ["钥匙", /钥匙|门钥匙/],
  ["钱包", /钱包|钱夹/],
  ["书本", /书本|书籍|小说|课本/],
  ["照片", /照片|相片|合影/],
  ["行李箱", /行李箱|旅行箱|皮箱/],
  ["餐具", /餐具|碗筷|筷子|饭碗/],
  ["票据", /票据|账单|收据|发票/],
  ["武器", /刀剑|长剑|短刀|手枪|步枪|武器/],
];

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function slug(value) {
  return text(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42) || "asset";
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(text).filter(Boolean))];
}

function normalizeCategory(value) {
  return PRODUCTION_ASSET_CATEGORIES.includes(value) ? value : "prop";
}

function mergePreserved(derived, existing) {
  const previous = existing.get(derived.id);
  if (!previous) return derived;
  return {
    ...derived,
    ...previous,
    id: derived.id,
    category: derived.category,
    source: previous.source === "manual" ? "manual" : "auto",
    linkedCharacterId: derived.linkedCharacterId || previous.linkedCharacterId || "",
    shotIds:
      previous.source === "manual"
        ? uniqueStrings([...(derived.shotIds || []), ...(previous.shotIds || [])])
        : uniqueStrings(derived.shotIds || []),
  };
}

export function productionAssetCategoryLabel(category) {
  return CATEGORY_LABELS[normalizeCategory(category)];
}

export function normalizeProductionAssets(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === "object")
    .map((item, index) => {
      const category = normalizeCategory(item.category);
      const name = text(item.name) || `${productionAssetCategoryLabel(category)} ${index + 1}`;
      return {
        id: text(item.id) || `asset-${category}-${index + 1}`,
        category,
        name,
        description: text(item.description),
        prompt: text(item.prompt),
        enabled: item.enabled !== false,
        source: item.source === "manual" ? "manual" : "auto",
        linkedCharacterId: text(item.linkedCharacterId),
        shotIds: uniqueStrings(item.shotIds),
        referenceImage: text(item.referenceImage),
        generatedImage: text(item.generatedImage),
        generationState: ["idle", "queued", "submitting", "generating", "downloading", "done", "error", "cancelled"].includes(item.generationState)
          ? item.generationState
          : "idle",
        error: text(item.error),
      };
    });
}

function sceneName(shot) {
  const explicit = text(shot?.scene);
  if (explicit) return explicit;
  const content = `${text(shot?.visual)} ${text(shot?.narration)}`;
  const patterns = [
    ["室内", /室内|房间|客厅|卧室|办公室|教室|厨房|餐厅/],
    ["街道", /街道|巷子|路口|石板路|马路/],
    ["城市", /城市|高楼|城区|广场/],
    ["乡村", /乡村|村庄|田野|农舍/],
    ["山林", /山林|森林|树林|山谷/],
    ["海边", /海边|海岸|沙滩|码头/],
    ["车内", /车内|汽车|火车|地铁/],
    ["医院", /医院|诊室|病房/],
    ["学校", /学校|校园|教室/],
  ];
  return patterns.find(([, pattern]) => pattern.test(content))?.[0] || "通用场景";
}

function characterIdsForShot(shot) {
  return uniqueStrings(shot?.characterIds);
}

export function deriveProductionAssets(shots, characters, previousAssets = []) {
  const safeShots = Array.isArray(shots) ? shots : [];
  const safeCharacters = Array.isArray(characters) ? characters : [];
  const existing = new Map(normalizeProductionAssets(previousAssets).map((asset) => [asset.id, asset]));
  const derived = [];

  for (const character of safeCharacters) {
    const characterId = text(character?.id);
    const name = text(character?.name);
    if (!characterId || !name) continue;
    const shotIds = safeShots
      .filter((shot) => characterIdsForShot(shot).includes(characterId))
      .map((shot) => text(shot.id))
      .filter(Boolean);
    const id = `costume:${characterId}:default`;
    derived.push(mergePreserved({
      id,
      category: "costume",
      name: `${name}·默认服装`,
      description: `${name}在相关镜头中的固定服装、鞋履与随身配饰。`,
      prompt: `${name}的默认服装设定，固定服装款式、材质、颜色、鞋履和随身配饰，跨镜头保持连续一致。`,
      enabled: true,
      source: "auto",
      linkedCharacterId: characterId,
      shotIds,
      referenceImage: "",
      generatedImage: "",
      generationState: "idle",
      error: "",
    }, existing));
  }

  const scenes = new Map();
  for (const shot of safeShots) {
    const name = sceneName(shot);
    const key = slug(name);
    const item = scenes.get(key) || { name, shotIds: [], examples: [] };
    if (shot?.id) item.shotIds.push(text(shot.id));
    if (shot?.visual) item.examples.push(text(shot.visual));
    scenes.set(key, item);
  }
  for (const [key, scene] of scenes) {
    const id = `scene:${key}`;
    const example = scene.examples.find(Boolean) || "";
    derived.push(mergePreserved({
      id,
      category: "scene",
      name: scene.name,
      description: example || `${scene.name}的固定空间、建筑、陈设与光线设定。`,
      prompt: `${scene.name}场景设定，固定空间结构、建筑材质、陈设位置、时代细节、天气与主光方向；不同镜头保持同一地点连续性。${example ? ` 参考情境：${example}` : ""}`,
      enabled: true,
      source: "auto",
      linkedCharacterId: "",
      shotIds: uniqueStrings(scene.shotIds),
      referenceImage: "",
      generatedImage: "",
      generationState: "idle",
      error: "",
    }, existing));
  }

  for (const [name, pattern] of PROP_PATTERNS) {
    const shotIds = safeShots
      .filter((shot) => pattern.test(`${text(shot?.visual)} ${text(shot?.narration)} ${text(shot?.dialogue)}`))
      .map((shot) => text(shot.id))
      .filter(Boolean);
    if (!shotIds.length) continue;
    const id = `prop:${slug(name)}`;
    derived.push(mergePreserved({
      id,
      category: "prop",
      name,
      description: `${name}在相关镜头中的固定造型与使用状态。`,
      prompt: `${name}道具设定，固定造型、材质、颜色、尺寸、磨损程度和关键细节，跨镜头保持一致。`,
      enabled: true,
      source: "auto",
      linkedCharacterId: "",
      shotIds: uniqueStrings(shotIds),
      referenceImage: "",
      generatedImage: "",
      generationState: "idle",
      error: "",
    }, existing));
  }

  const derivedIds = new Set(derived.map((asset) => asset.id));
  const manual = [...existing.values()].filter((asset) => asset.source === "manual" && !derivedIds.has(asset.id));
  return normalizeProductionAssets([...derived, ...manual]);
}

export function productionAssetsForShot(shot, assets) {
  const safeAssets = normalizeProductionAssets(assets).filter((asset) => asset.enabled);
  const manualIds = uniqueStrings(shot?.productionAssetIds);
  if (shot?.productionAssetSelectionMode === "manual") {
    const selected = new Set(manualIds);
    return safeAssets.filter((asset) => selected.has(asset.id));
  }
  const shotId = text(shot?.id);
  const characterIds = new Set(characterIdsForShot(shot));
  return safeAssets.filter((asset) => asset.shotIds.includes(shotId) || (asset.linkedCharacterId && characterIds.has(asset.linkedCharacterId)));
}

export function productionAssetPromptBlock(assets) {
  const safeAssets = normalizeProductionAssets(assets).filter((asset) => asset.enabled);
  if (!safeAssets.length) return "";
  const lines = [];
  for (const category of PRODUCTION_ASSET_CATEGORIES) {
    const group = safeAssets.filter((asset) => asset.category === category);
    if (!group.length) continue;
    lines.push(`${productionAssetCategoryLabel(category)}资产：${group.map((asset) => `${asset.name}（${asset.prompt || asset.description || "保持连续一致"}）`).join("；")}`);
  }
  return lines.join("\n");
}

export function productionAssetReferences(assets) {
  const references = [];
  const seen = new Set();
  for (const asset of normalizeProductionAssets(assets)) {
    if (!asset.enabled) continue;
    const src = asset.generatedImage || asset.referenceImage;
    if (!src || seen.has(src)) continue;
    seen.add(src);
    references.push({ id: asset.id, category: asset.category, name: asset.name, src });
  }
  return references;
}

export function createManualProductionAsset(category, index = 1) {
  const normalized = normalizeCategory(category);
  const label = productionAssetCategoryLabel(normalized);
  return {
    id: `asset-${normalized}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    category: normalized,
    name: `${label} ${index}`,
    description: "",
    prompt: "",
    enabled: true,
    source: "manual",
    linkedCharacterId: "",
    shotIds: [],
    referenceImage: "",
    generatedImage: "",
    generationState: "idle",
    error: "",
  };
}
