"use client";

import { ChangeEvent, useEffect, useMemo, useRef, useState, WheelEvent as ReactWheelEvent } from "react";
import { assetStateLabel, buildGenerationNotice, getExportBlockReason, guardPaidTaskDestruction, isPaidJournalEntryUnresolved, paidSubmissionRiskFromError, PLACEHOLDER_CHARACTER_NAMES, pollPaidTaskUntilSettled, prepareStoryboardClear, providerHttpRejectionMessage, restoreStoryboardSnapshot, stopShotLocally, validateCharacterNames, videoPollingPolicy, videoTaskAction } from "./workflow-safety.mjs";
import { inferCharacterStage, inferPrimaryCharacterProfile, inferSecondaryCharacterName } from "./character-inference.mjs";
import { normalizeProviders } from "./provider-routing.mjs";
import { createDemoCharacterDescription } from "./character-profile.mjs";
import { alignShotsToVoice } from "./timeline-sync.mjs";
import { cinematicDuration, cinematicShotPlan, splitScriptIntoCinematicBeats, validateCinematicCoverage } from "./cinematic-storyboard.mjs";
import { importedPackageSummary, parseProjectPackageText } from "./project-package.mjs";
import { extractShortDramaCharacters, sampleShortDramaScript, shortDramaDuration, shortDramaLineMetadata, shortDramaShotPlan, splitShortDramaBeats } from "./short-drama.mjs";
import { allocateSplitDurations, reflowShotTimeline, splitTextMatchesSource, suggestShotSplit } from "./manual-shot-split.mjs";

type AssetState = "idle" | "submitting" | "generating" | "downloading" | "ready" | "error" | "canceled";
type CharacterKey = string;
type VideoImageRole = "reference_image" | "first_frame";
type CreationMode = "narration" | "short_drama";
type Shot = {
  id: string;
  narration: string;
  duration: number;
  start: number;
  end: number;
  visual: string;
  shotType: string;
  camera: string;
  scene?: string;
  speaker?: string;
  dialogue?: string;
  extras?: string;
  imagePrompt: string;
  videoPrompt: string;
  approved: boolean;
  imageState: AssetState;
  videoState: AssetState;
  variant: number;
  characterIds?: CharacterKey[];
  characterSelectionMode?: "auto" | "manual";
  characterStageOverrides?: Partial<Record<CharacterKey, CharacterStage>>;
  imageUrl?: string;
  videoUrl?: string;
  videoTaskId?: string;
  videoTaskProvider?: string;
  videoSubmissionRisk?: boolean;
  error?: string;
};

type Providers = { storyboard: string; image: string; video: string; voice: string };
type ApiProviderConfig = { apiKey: string; hasKey: boolean; clearApiKey: boolean; baseUrl: string; storyboardModel: string; imageModel: string; videoModel: string; voiceModel: string; voice: string; workflowPath: string; fps: string; steps: string };
type ProviderSection = "openai" | "custom" | "elevenlabs" | "comfyui";
type AppSettings = { mode: "demo" | "live"; openai: ApiProviderConfig; custom: ApiProviderConfig; elevenlabs: ApiProviderConfig; comfyui: ApiProviderConfig };
type PublicApiProviderConfig = Omit<ApiProviderConfig, "apiKey" | "clearApiKey">;
type PublicAppSettings = { mode: "demo" | "live"; openai: PublicApiProviderConfig; custom: PublicApiProviderConfig; elevenlabs: PublicApiProviderConfig; comfyui: PublicApiProviderConfig };
type CharacterStage = "child" | "adult" | "elder";
type CharacterAnchor = { id: CharacterKey; name: string; description: string; masterImage?: string; prompt?: string; aliases?: string[]; stages?: CharacterStage[]; firstPerson?: boolean };
type ManualCharacter = { id: string; name: string; description: string; enabled: boolean; referenceImage: string; generatedImage: string };
type CharacterPreview = { name: string; src: string; prompt: string };
type ShotSplitDraft = { shotId: string; first: string; second: string; error: string };
type ShotCharacterLibraryDraft = { shotId: string; selectedIds: string[]; error: string };
type VideoStyle = { name: string; detail: string; prompt: string; tone: string };
type StorageInfo = { userDataPath: string; mediaPath: string; settingsFile: string; paidTaskJournalFile: string };
type PaidTaskJournalEntry = { projectId: string; shotId: string; provider?: string; status: string; taskId?: string | null; remoteStatus?: string; localResultSavedAt?: string; httpStatus?: number; providerCode?: string; requestId?: string; attempt?: number; updatedAt: string };
type BlockedPaidTask = { shotId: string; provider?: string; status: string; taskId?: string | null; reason: string };
type GenerationNotice = { title: string; model: string; provider: string; itemCount: number; uploads: string; cancellation: string; failureBilling: string; billing: string };
type GenerationProgress = { id: number; title: string; detail: string; status: "running" | "success" | "error" | "canceled"; current: number; total: number };
type VoiceProvenance = { mediaId: string; scriptSha256: string; duration: number; source: string };

declare global {
  interface Window {
    mujingDesktop?: {
      isDesktop: boolean;
      getAppVersion: () => Promise<string>;
      getSettings: () => Promise<PublicAppSettings>;
      getStorageInfo: () => Promise<StorageInfo>;
      saveSettings: (settings: AppSettings) => Promise<PublicAppSettings>;
      testConnection: (settings: AppSettings) => Promise<{ ok: boolean; models?: number; model?: string; modelVisible?: boolean; voiceId?: string; gpuName?: string; vramGb?: number | null; workflow?: string }>;
      chooseComfyUIWorkflow: () => Promise<{ canceled?: boolean; path?: string; name?: string }>;
      createCharacterProfile: (payload: object) => Promise<{ description: string }>;
      createStoryboard: (payload: object) => Promise<{ shots: Partial<Shot>[] }>;
      optimizeImagePrompt: (payload: object) => Promise<{ prompt: string }>;
      optimizeVideoPrompt: (payload: object) => Promise<{ prompt: string }>;
      analyzeStyleReference: (payload: object) => Promise<{ prompt: string }>;
      createImage: (payload: object) => Promise<{ url: string }>;
      submitVideoTask: (payload: object) => Promise<{ jobId: string; status: string; provider?: string }>;
      requestVideoResubmitAuthorization: (payload: object) => Promise<{ authorized: boolean; token?: string; expiresAt?: number }>;
      resubmitVideoTask: (payload: object) => Promise<{ jobId: string; status: string; provider: string }>;
      getPaidVideoTasks: (projectId: string) => Promise<PaidTaskJournalEntry[]>;
      abandonPaidVideoTask: (payload: { projectId: string; shotId: string }) => Promise<{ abandoned: boolean; count?: number; remoteMayContinue?: boolean }>;
      pollVideoTask: (payload: object) => Promise<{ url?: string; jobId: string; status: string; error?: string }>;
      cancelVideoTask: (payload: object) => Promise<{ jobId?: string; status: string }>;
      onAssetProgress: (callback: (progress: { shotId?: string; jobId?: string; kind: "image" | "video"; status: AssetState }) => void) => () => void;
      createSpeech: (payload: object) => Promise<{ url: string; provenance: VoiceProvenance }>;
      createDemoSpeech: (payload: object) => Promise<{ url: string; provenance: VoiceProvenance }>;
      saveDataUrl: (payload: { dataUrl: string; prefix: string }) => Promise<{ url: string }>;
      chooseMusic: () => Promise<{ canceled?: boolean; url?: string; name?: string }>;
      exportVideo: (payload: object) => Promise<{ canceled?: boolean; ok?: boolean; outputPath?: string }>;
    };
  }
}

const defaultAppSettings: AppSettings = {
  mode: "demo",
  openai: { apiKey: "", hasKey: false, clearApiKey: false, baseUrl: "https://api.openai.com/v1", storyboardModel: "gpt-5.6", imageModel: "gpt-image-2", videoModel: "sora-2", voiceModel: "gpt-4o-mini-tts", voice: "coral", workflowPath: "", fps: "", steps: "" },
  custom: { apiKey: "", hasKey: false, clearApiKey: false, baseUrl: "", storyboardModel: "", imageModel: "", videoModel: "", voiceModel: "", voice: "", workflowPath: "", fps: "", steps: "" },
  elevenlabs: { apiKey: "", hasKey: false, clearApiKey: false, baseUrl: "https://api.elevenlabs.io/v1", storyboardModel: "", imageModel: "", videoModel: "", voiceModel: "eleven_v3", voice: "", workflowPath: "", fps: "", steps: "" },
  comfyui: { apiKey: "", hasKey: false, clearApiKey: false, baseUrl: "http://127.0.0.1:8188", storyboardModel: "", imageModel: "", videoModel: "wan2.2-ti2v-5b", voiceModel: "", voice: "", workflowPath: "", fps: "24", steps: "30" },
};

function createProjectId() {
  return globalThis.crypto?.randomUUID?.() || `project-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

const steps = [
  { id: 1, number: "01", label: "文稿", detail: "准备解说内容" },
  { id: 2, number: "02", label: "角色", detail: "锁定人物与风格" },
  { id: 3, number: "03", label: "分镜", detail: "设计画面与运镜" },
  { id: 4, number: "04", label: "生成", detail: "制作图片和视频" },
  { id: 5, number: "05", label: "成片", detail: "时间轴与导出" },
];

const sampleScript = `那天清晨，我第一次走进这座被群山环抱的小镇。

薄雾还没有散去，石板路上只有零星的脚步声。街角的面包店刚刚亮起灯，一位老人推开木窗，向远处的钟楼望去。

没人知道，几个小时后，这里会发生一件改变所有人的事。`;

const shotTypes = ["航拍远景", "低机位中景", "室内近景", "人物特写", "仰拍特写", "广角全景"];
const shotSizeOptions = ["大远景", "远景", "全景", "中全景", "中景", "中近景", "近景", "特写", "大特写", "过肩镜头", "主观镜头"];
const cameras = ["缓慢俯冲推进", "贴地平稳跟移", "轻微横摇", "极缓慢推近", "静止后快速上摇", "缓慢后退拉远"];
const queueStateLegend = ["等待生成", "正在提交", "生成中", "下载中", "已完成", "生成失败", "已取消"];
const videoStyles: VideoStyle[] = [
  { name: "电影写实", detail: "自然电影光与真实质感", prompt: "电影级写实摄影，自然肤色，柔和电影光，高动态范围，真实镜头景深，克制调色", tone: "cinematic" },
  { name: "温暖纪录片", detail: "生活感、手持与暖色光", prompt: "温暖人文纪录片风格，自然手持摄影，柔和暖色日光，真实生活细节，轻微胶片颗粒", tone: "documentary" },
  { name: "复古胶片", detail: "低饱和与怀旧颗粒", prompt: "复古电影胶片质感，低饱和色彩，柔和高光，细腻颗粒，轻微暗角，怀旧年代感", tone: "film" },
  { name: "东方水墨", detail: "留白、墨色与诗意气韵", prompt: "东方水墨电影美学，大面积留白，墨色层次，含蓄色彩，诗意雾气，流动笔触质感", tone: "ink" },
  { name: "3D 动画", detail: "精致材质与柔和体积光", prompt: "高品质三维动画电影风格，精致角色材质，柔和体积光，清晰轮廓，丰富但克制的色彩", tone: "animation" },
  { name: "动漫风格", detail: "二维线稿、赛璐璐与戏剧光影", prompt: "高品质二维动漫电影风格，精细清晰线稿，赛璐璐分层上色，富有表现力的角色眼神与表情，统一人物设定，电影感构图，戏剧性光影，丰富背景细节，稳定画风与色彩，无文字、无水印", tone: "anime" },
  { name: "日系治愈", detail: "通透空气感与轻柔色彩", prompt: "日系治愈电影风格，通透空气感，柔和浅色调，自然逆光，细腻日常氛围，干净构图", tone: "healing" },
  { name: "悬疑冷调", detail: "冷色阴影与紧张光比", prompt: "悬疑电影冷调，青蓝阴影，高反差侧光，压抑空间层次，克制饱和度，紧张叙事氛围", tone: "suspense" },
  { name: "自定义风格", detail: "输入你的统一视觉指令", prompt: "统一的自定义视频视觉风格", tone: "custom" },
];

const voiceOptions = [
  { id: "marin", name: "Marin · 清晰自然（推荐）" },
  { id: "cedar", name: "Cedar · 沉稳叙事" },
  { id: "coral", name: "Coral · 温暖亲和" },
  { id: "alloy", name: "Alloy · 中性平衡" },
  { id: "nova", name: "Nova · 明亮轻盈" },
  { id: "onyx", name: "Onyx · 低沉厚重" },
  { id: "sage", name: "Sage · 成熟克制" },
  { id: "shimmer", name: "Shimmer · 柔和细腻" },
];

function formatTime(seconds: number) {
  const mins = Math.floor(seconds / 60).toString().padStart(2, "0");
  const secs = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${mins}:${secs}`;
}

function isGenericPrimaryDescription(value: string) {
  const normalized = value.trim();
  return !normalized || normalized === "故事中的主要人物，保持面部、发型、服装、体型和随身物品在全部镜头中一致" || normalized === "叙述者，故事中的主要人物；保持面部、发型、服装、体型和随身物品在全部镜头中一致";
}

function visualForNarration(narration: string, index: number, characterName: string) {
  const clean = narration.replace(/[。！？!?]/g, "");
  if (/自行车|骑车|邮差/.test(narration)) return `低机位跟拍${characterName}骑车穿过街道，完整呈现“${clean}”，人物、车辆与环境动作清楚连贯`;
  if (/信封|信件|一封.*信|邮包/.test(narration)) return `近景呈现${characterName}从邮包中取出信封并查看细节，完整表达“${clean}”，信封与手部动作自然清晰`;
  if (/钟楼|时钟|指针/.test(narration)) return `从${characterName}的视线切向远处钟楼，完整呈现“${clean}”，钟面时间准确可见，制造时间迫近的悬念`;
  if (/清晨|小镇|海边|雾/.test(narration)) return `建立镜头展示故事发生的海边小镇，完整呈现“${clean}”，淡蓝晨雾、石板街与远处建筑形成空间层次`;
  return `${shotTypes[index % shotTypes.length]}呈现“${clean}”，主体动作明确，环境细节服务于叙事，不添加无关人物或物品`;
}

function characterStageLabel(stage: CharacterStage) {
  return stage === "child" ? "童年阶段" : stage === "elder" ? "老年阶段" : "成年阶段";
}

function performanceDirectionForNarration(narration: string, hasCharacter = true) {
  if (!hasCharacter) return "情境氛围必须忠于文案，不使用与叙事冲突的轻松或摆拍感";
  if (/反对|拒绝|不行|不能|制止|阻止|否定|错的/.test(narration)) return "人物表情坚定克制，眉眼略微收紧，嘴唇自然抿住，目光直视对方或争议对象；配合清楚但不过度夸张的拒绝手势，不能微笑";
  if (/害怕|恐惧|惊慌|逃|危险|威胁/.test(narration)) return "人物眼神警觉紧张，呼吸感明显，眉头轻蹙，身体略微防御或后撤，避免夸张惊叫";
  if (/难过|悲伤|失去|离开|眼泪|哭|遗憾|愧疚/.test(narration)) return "人物神情压抑而真实，眼神下垂或失焦，眉间有轻微哀伤，动作迟缓克制，避免戏剧化嚎哭";
  if (/愤怒|生气|争吵|质问|不公/.test(narration)) return "人物压住愤怒，眉头收紧、下颌微绷，目光坚定，手部动作有力度但保持现实表演尺度";
  if (/惊讶|震惊|没想到|突然|发现/.test(narration)) return "人物出现短暂而可信的惊讶，眼神迅速聚焦、眉毛轻抬，动作瞬间停顿，不使用夸张表情";
  if (/高兴|开心|幸福|释然|成功|终于/.test(narration)) return "人物露出自然克制的喜悦或释然，眼神放松、嘴角轻扬，姿态舒展，避免广告式大笑";
  if (/犹豫|迟疑|纠结|思考|想/.test(narration)) return "人物神情专注而犹豫，目光短暂游移后聚焦，眉间轻微收拢，动作停顿体现内心权衡";
  if (/决定|坚持|必须|守住|面对/.test(narration)) return "人物目光稳定坚定，表情克制，身体姿态略微前倾，呈现做出决定后的力量感";
  return "人物表情自然真实，眼神、嘴角、眉间与身体姿态必须准确回应当前文案情境，避免空洞微笑、摆拍和与台词无关的表情";
}

function detailedVideoPrompt(shot: Pick<Shot, "duration" | "visual" | "shotType" | "camera" | "narration">, performanceDirection: string, characterAnchor: string) {
  return `镜头时长 ${shot.duration} 秒，${shot.shotType}。开场状态：${shot.visual}。主体动作与表演：${performanceDirection}，人物在镜头时长内连续、自然地完成当前叙事动作，眼神和身体重心变化清楚。摄影机：从当前构图开始，${shot.camera}，速度克制均匀、运动方向明确，在动作完成时稳定停下。动态细节：呼吸、眨眼、衣物与头发轻微自然运动，环境光影和空气缓慢变化，背景活动不过度抢眼。结尾状态必须承接下一镜头的动作或视线${characterAnchor}。保持同一人物身份、五官与服装稳定，无变脸、无肢体畸变、无多余手指、无主体漂移、无闪烁、无文字、无水印`;
}

function referenceFaceVisibility(text: string) {
  if (/背影|背向镜头|背对镜头|后脑|不露脸|面部不可见|脸部被遮挡|兜帽遮住/.test(text)) return "hidden";
  if (/侧脸|侧面|侧身|低头|俯身|面部部分遮挡|人物面部较小|脸部较小|小比例人物|远处人物|面孔细节不清|脸部细节不清|行走中的侧脸/.test(text)) return "partial";
  return "visible";
}

function videoIdentityGuard(shot: Pick<Shot, "visual" | "videoPrompt">, characters: CharacterAnchor[]) {
  const bound = characters.filter((character) => character.masterImage);
  const names = bound.map((character) => character.name);
  if (!names.length) return "";
  const ensemble = bound.length > 1 ? `画面中固定保留 ${bound.length} 个不同角色（${bound.map((character) => `${character.name}：${character.description}`).join("；")}）；不得融合或互换五官、发型、服装与身体特征，保持分镜图中的左右站位、身高关系、视线方向和互动关系` : "";
  const visibility = referenceFaceVisibility(`${shot.visual} ${shot.videoPrompt}`);
  if (visibility === "hidden") return `身份连续性：${names.join("、")}的角色母版已在分镜图中锁定；${ensemble ? `${ensemble}；` : ""}严格继承分镜图中的背向姿态、体型、发型轮廓、服装配色和随身物品，镜头内不得强行转身或凭空生成不可见的正脸`;
  if (visibility === "partial") return `身份连续性：${names.join("、")}的角色母版已在分镜图中锁定；${ensemble ? `${ensemble}；` : ""}严格继承分镜图中的头部角度、侧脸方向、脸部大小、当前可见轮廓、发型、体型和服装；只允许低幅度慢动作，不强行转正脸，不做快速转头、夸张表情或连续口型，不让遮挡物掠过面部，人物与摄影机不得同时大幅运动；脸部像素不足时不得凭空补画五官`;
  return `身份连续性：${names.join("、")}的角色母版已在分镜图中锁定；${ensemble ? `${ensemble}；` : ""}严格继承分镜图中每个角色各自的脸部轮廓、五官比例、发型、体型和服装，不改变身份`;
}

function resolvedCharacterStage(narration: string, character: CharacterAnchor, overrides: Shot["characterStageOverrides"] = {}) {
  const override = overrides?.[character.id];
  if (override && (character.stages || []).includes(override)) return override;
  return inferCharacterStage(narration, character.stages || []) as CharacterStage;
}

function compileCharacterAnchor(characters: CharacterAnchor[], narration = "", overrides: Shot["characterStageOverrides"] = {}) {
  if (!characters.length) return "";
  const library = characters.map((character) => {
    const stage = resolvedCharacterStage(narration, character, overrides);
    const stageText = character.stages?.length ? `；本镜头为${characterStageLabel(stage)}` : "";
    return `${character.name}（${character.description}${stageText}）`;
  }).join("；");
  const masters = characters.filter((character) => character.masterImage).map((character) => character.name);
  const masterInstruction = masters.length ? `。已绑定${masters.join("、")}的角色母版图；母版身份优先级高于其他画面描述，必须使用母版中的同一张脸和同一人物身份` : "";
  return `，角色库：${library}${masterInstruction}。仅让解说中明确涉及的角色出镜；不得把同一角色复制成不同人物，不得擅自增加兄弟姐妹或其他未提及人物。跨年龄镜头只改变年龄、身高和阶段服装，眼型、鼻型、唇形、脸部骨骼、发色与标志性神态必须连续一致`;
}

function buildCharacterPrompt(character: Pick<CharacterAnchor, "name" | "description" | "stages">, style: string, hasReference = false) {
  const identityRule = hasReference
    ? "以角色参考图为唯一身份基准，严格保持面部轮廓、五官比例、发型、发色、体型、服装配色和随身物品一致"
    : "以这份文字角色设定为身份基准，固定面部轮廓、五官比例、发型、发色、体型、服装配色和随身物品";
  const stages = character.stages || [];
  const stagePrompt = stages.length > 1
    ? `同一人物跨年龄身份母版，${stages.map(characterStageLabel).join("与")}并列角色设定图；各阶段必须共享眼型、鼻型、唇形、脸部骨骼、发色和标志性神态，只允许自然年龄变化。每个阶段提供正面半身像，禁止生成无关人物`
    : "单人角色身份母版，正面半身构图，人物居中";
  return `${character.name}，${character.description}。${identityRule}。${stagePrompt}。${style}，自然柔和光线，背景简洁，皮肤与衣物细节清晰，无文字、无水印、无多余人物。`;
}

function charactersForNarration(narration: string, characters: CharacterAnchor[]) {
  const roleAliases = ["女孩", "姑娘", "女人", "男孩", "少年", "青年", "男人", "老人", "邮差", "记者", "医生", "老师", "警察", "律师"];
  const directlyMentioned = characters.filter((character) => [character.name, ...(character.aliases || [])].some((alias) => alias && narration.includes(alias)));
  if (directlyMentioned.length) return directlyMentioned;
  const primary = characters.find((character) => character.id === "primary");
  if (primary?.firstPerson && /童年|小时候|儿时|幼年|年幼|少年时期|孩提|年幼的孩子|成年后的自己|成年叙述者|老年叙述者/.test(narration)) return [primary];
  const byRole = characters.filter((character) => roleAliases.some((alias) => narration.includes(alias) && `${character.name}${character.description}`.includes(alias)));
  if (byRole.length) return byRole;
  if (/(?:^|[，。！？；])\s*(?:我|他|她|主角)/.test(narration) && characters[0]) return [characters[0]];
  return [];
}

function buildShots(text: string, options: { style: string; ratio: string; pace: string; characters: CharacterAnchor[]; creationMode?: CreationMode }): Shot[] {
  const shortDrama = options.creationMode === "short_drama";
  const lines = shortDrama ? splitShortDramaBeats(text) : splitScriptIntoCinematicBeats(text, { pace: options.pace });
  let cursor = 0;
  let currentScene = "";
  return lines.map((narration, index) => {
    const dramaMetadata = shortDrama ? shortDramaLineMetadata(narration, currentScene) : { kind: "narration", scene: "", speaker: "", dialogue: "", extras: "" };
    if (shortDrama && dramaMetadata.kind === "scene") currentScene = dramaMetadata.scene;
    const plan = shortDrama ? shortDramaShotPlan(index, dramaMetadata) : cinematicShotPlan(index);
    const duration = shortDrama ? shortDramaDuration(narration, dramaMetadata, options.pace) : cinematicDuration(narration, { shotType: plan.shotType, pace: options.pace });
    const referencedCharacters = charactersForNarration(narration, options.characters);
    const dramaVisual = dramaMetadata.kind === "scene"
      ? `${dramaMetadata.scene}的空间建立镜头，清楚交代时间、入口、人物活动区域与环境层次`
      : dramaMetadata.kind === "dialogue"
        ? `${dramaMetadata.speaker || "说话人"}在${currentScene || "当前场景"}说出对白，表情、视线和身体姿态准确体现台词潜台词${dramaMetadata.extras ? `，背景有${dramaMetadata.extras}作自然反应` : ""}`
        : `${currentScene ? `${currentScene}内，` : ""}${narration}${dramaMetadata.extras ? `，${dramaMetadata.extras}保持自然背景表演` : ""}`;
    const visual = shortDrama ? dramaVisual : visualForNarration(narration, index, referencedCharacters[0]?.name ?? options.characters[0]?.name ?? "主要人物");
    const characterAnchor = compileCharacterAnchor(referencedCharacters, narration);
    const performanceDirection = performanceDirectionForNarration(narration, referencedCharacters.length > 0);
    const shot: Shot = {
      id: `shot-${String(index + 1).padStart(2, "0")}`,
      narration,
      duration,
      start: cursor,
      end: cursor + duration,
      visual,
      shotType: plan.shotType,
      camera: plan.camera,
      scene: shortDrama ? currentScene : undefined,
      speaker: shortDrama ? dramaMetadata.speaker : undefined,
      dialogue: shortDrama ? dramaMetadata.dialogue : undefined,
      extras: shortDrama ? dramaMetadata.extras : undefined,
      imagePrompt: `${shortDrama ? "电影感短剧镜头。" : ""}景别：${plan.shotType}。${visual}。人物表情与情境表演：${performanceDirection}。${options.style}，${options.ratio}${characterAnchor}，对白只作为表演依据，画面无文字、无水印`,
      videoPrompt: `${shortDrama ? `短剧对白与表演镜头；${dramaMetadata.dialogue ? `说话人自然说出“${dramaMetadata.dialogue}”，` : ""}` : ""}${detailedVideoPrompt({ duration, visual, shotType: plan.shotType, camera: plan.camera, narration }, performanceDirection, characterAnchor)}`,
      approved: false,
      imageState: "idle",
      videoState: "idle",
      variant: index % 6,
      characterIds: referencedCharacters.map((character) => character.id),
    };
    cursor += duration;
    return shot;
  });
}

function syncShotCharacters(shot: Shot, characters: CharacterAnchor[], style: string, ratio: string): Partial<Shot> {
  const referencedCharacters = shot.characterSelectionMode === "manual"
    ? characters.filter((character) => shot.characterIds?.includes(character.id))
    : charactersForNarration(shot.narration, characters);
  const characterAnchor = compileCharacterAnchor(referencedCharacters, shot.narration, shot.characterStageOverrides);
  const performanceDirection = performanceDirectionForNarration(shot.narration, referencedCharacters.length > 0);
  const dramaContext = shot.scene || shot.speaker || shot.dialogue || shot.extras
    ? `短剧镜头；场景：${shot.scene || "当前场景"}；${shot.speaker ? `说话人：${shot.speaker}；` : ""}${shot.dialogue ? `对白潜台词：${shot.dialogue}；` : ""}${shot.extras ? `群众调度：${shot.extras}；` : ""}`
    : "";
  return {
    characterIds: referencedCharacters.map((character) => character.id),
    imagePrompt: `${dramaContext}景别：${shot.shotType}。${shot.visual}。人物表情与情境表演：${performanceDirection}。${style}，${ratio}${characterAnchor}，对白只作为表演依据，画面无文字、无水印`,
    videoPrompt: `${dramaContext}景别：${shot.shotType}。${detailedVideoPrompt(shot, performanceDirection, characterAnchor)}`,
  };
}

function wait(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function restoreLocalMediaUrl(value: unknown) {
  if (typeof value !== "string" || !value) return "";
  try {
    const url = new URL(value);
    return url.pathname.startsWith("/__media/") ? `${window.location.origin}${url.pathname}` : value;
  } catch { return value; }
}

function createDemoFrame(shot: Shot, ratio: string) {
  const canvas = document.createElement("canvas");
  canvas.width = ratio === "9:16" ? 720 : 1280;
  canvas.height = ratio === "9:16" ? 1280 : 720;
  const context = canvas.getContext("2d");
  if (!context) return "";
  const palettes = [
    ["#93aea3", "#1d3a2d", "#e4c58f"], ["#7d9189", "#263b34", "#d7a36c"],
    ["#a89881", "#3a332b", "#e8d3a5"], ["#6e8585", "#182c2e", "#b9cfca"],
    ["#92a29a", "#32483f", "#dfbc82"], ["#60756f", "#172923", "#b3a084"],
  ][shot.variant % 6];
  const sky = context.createLinearGradient(0, 0, 0, canvas.height);
  sky.addColorStop(0, palettes[0]); sky.addColorStop(.62, palettes[1]); sky.addColorStop(1, "#101b16");
  context.fillStyle = sky; context.fillRect(0, 0, canvas.width, canvas.height);
  context.globalAlpha = .5;
  for (let index = 0; index < 5; index += 1) {
    context.fillStyle = index % 2 ? palettes[2] : "#d8dfd8";
    const width = canvas.width * (.18 + index * .025);
    const height = canvas.height * (.13 + (index % 3) * .05);
    context.fillRect(canvas.width * (.08 + index * .18), canvas.height * .63 - height, width, height);
  }
  context.globalAlpha = 1;
  const glow = context.createRadialGradient(canvas.width * .78, canvas.height * .2, 0, canvas.width * .78, canvas.height * .2, canvas.width * .16);
  glow.addColorStop(0, "rgba(255,225,165,.9)"); glow.addColorStop(1, "rgba(255,225,165,0)");
  context.fillStyle = glow; context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "rgba(8,18,13,.55)"; context.fillRect(0, canvas.height * .76, canvas.width, canvas.height * .24);
  context.fillStyle = "#fff"; context.font = `600 ${Math.round(canvas.width * .025)}px "Microsoft YaHei"`;
  context.fillText(`镜头 ${shot.id.replace("shot-", "")}`, canvas.width * .055, canvas.height * .84);
  context.fillStyle = "rgba(255,255,255,.78)"; context.font = `${Math.round(canvas.width * .014)}px "Microsoft YaHei"`;
  const line = shot.visual.length > 42 ? `${shot.visual.slice(0, 42)}…` : shot.visual;
  context.fillText(line, canvas.width * .055, canvas.height * .9);
  return canvas.toDataURL("image/png");
}

function createDemoCharacterReference(name: string, description: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 768;
  canvas.height = 1024;
  const context = canvas.getContext("2d");
  if (!context) return "";
  const seed = [...`${name}${description}`].reduce((sum, character) => (sum + (character.codePointAt(0) || 0)) % 360, 0);
  const background = context.createLinearGradient(0, 0, 0, canvas.height);
  background.addColorStop(0, `hsl(${seed}, 24%, 78%)`);
  background.addColorStop(1, `hsl(${(seed + 28) % 360}, 20%, 42%)`);
  context.fillStyle = background;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "rgba(255,255,255,.14)";
  context.beginPath(); context.arc(590, 190, 150, 0, Math.PI * 2); context.fill();
  context.fillStyle = `hsl(${(seed + 145) % 360}, 20%, 22%)`;
  context.beginPath(); context.ellipse(384, 900, 280, 300, 0, 0, Math.PI * 2); context.fill();
  context.fillStyle = "#b9957d";
  context.beginPath(); context.ellipse(384, 430, 150, 190, 0, 0, Math.PI * 2); context.fill();
  context.fillStyle = `hsl(${(seed + 180) % 360}, 18%, 16%)`;
  context.beginPath(); context.ellipse(384, 320, 160, 115, 0, Math.PI, Math.PI * 2); context.fill();
  context.strokeStyle = "rgba(35,30,28,.7)";
  context.lineWidth = 10;
  context.beginPath(); context.moveTo(315, 420); context.lineTo(355, 420); context.moveTo(413, 420); context.lineTo(453, 420); context.stroke();
  context.lineWidth = 6;
  context.beginPath(); context.moveTo(350, 520); context.quadraticCurveTo(384, 540, 418, 520); context.stroke();
  return canvas.toDataURL("image/png");
}

function StageLabel({ step }: { step: number }) {
  const names = ["SCRIPT", "CHARACTER", "STORYBOARD", "GENERATE", "TIMELINE"];
  return <span className="eyebrow">STEP {String(step).padStart(2, "0")} · {names[step - 1]}</span>;
}

function SceneArt({ shot, className = "", playhead, playing }: { shot: Shot; className?: string; playhead?: number; playing?: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = videoRef.current;
    if (!video || playhead === undefined || !shot.videoUrl) return;
    const target = Math.max(0, Math.min(shot.duration, playhead - shot.start));
    if (Math.abs(video.currentTime - target) > 0.45) video.currentTime = target;
    if (playing) void video.play().catch(() => {});
    else video.pause();
  }, [playhead, playing, shot.duration, shot.start, shot.videoUrl]);
  return (
    <div className={`scene-art scene-${shot.variant % 6} ${className}`}>
      {shot.videoUrl ? <video ref={videoRef} className="generated-media" src={shot.videoUrl} poster={shot.imageUrl} muted loop autoPlay={playhead === undefined} playsInline /> : shot.imageUrl ? <img key={shot.id} className={`generated-media ${playing ? "static-image-zoom" : ""}`} style={playing ? { animationDuration: `${Math.max(.5, shot.duration)}s` } : undefined} src={shot.imageUrl} alt={shot.visual} /> : <>
        <div className="scene-sun" />
        <div className="scene-mountain mountain-back" />
        <div className="scene-mountain mountain-front" />
        <div className="scene-town"><i /><i /><i /><i /><i /></div>
        <div className="scene-fog fog-one" /><div className="scene-fog fog-two" />
      </>}
      {shot.imageState === "generating" && <div className="asset-loading"><span />正在生成画面</div>}
      {shot.imageState === "idle" && <div className="scene-placeholder">分镜预览</div>}
      {((shot.imageState === "error" && !shot.imageUrl) || (shot.videoState === "error" && !shot.imageUrl)) && <div className="asset-error">生成失败 · 点击重试</div>}
      {shot.videoState === "ready" && <span className="video-ready-badge">▶ 视频</span>}
      {shot.imageUrl && !shot.videoUrl && playhead !== undefined && <span className="image-motion-badge">图片轻推近 · 100%→103%</span>}
    </div>
  );
}

export default function Home() {
  const [appVersion, setAppVersion] = useState("");
  const [activeStep, setActiveStep] = useState(1);
  const [projectId, setProjectId] = useState(createProjectId);
  const [projectName, setProjectName] = useState("雾中的小镇");
  const [script, setScript] = useState(sampleScript);
  const [creationMode, setCreationMode] = useState<CreationMode>("narration");
  const [ratio, setRatio] = useState("16:9");
  const [style, setStyle] = useState("电影写实");
  const [customStyle, setCustomStyle] = useState("");
  const [customStyleReferenceImage, setCustomStyleReferenceImage] = useState("");
  const [styleAnalysisBusy, setStyleAnalysisBusy] = useState(false);
  const [styleOpen, setStyleOpen] = useState(false);
  const [pace, setPace] = useState("自然");
  const [shots, setShots] = useState<Shot[]>([]);
  const [videoImageRole, setVideoImageRole] = useState<VideoImageRole>("reference_image");
  const [hydrated, setHydrated] = useState(false);
  const [paidTaskJournalReady, setPaidTaskJournalReady] = useState(false);
  const [blockedPaidTask, setBlockedPaidTask] = useState<BlockedPaidTask | null>(null);
  const [characterEnabled, setCharacterEnabled] = useState(true);
  const [characterName, setCharacterName] = useState("主要人物");
  const [characterDescription, setCharacterDescription] = useState("故事中的主要人物，保持面部、发型、服装、体型和随身物品在全部镜头中一致");
  const [referenceImage, setReferenceImage] = useState<string>("");
  const [secondaryCharacterEnabled, setSecondaryCharacterEnabled] = useState(true);
  const [secondaryCharacterName, setSecondaryCharacterName] = useState("第二角色");
  const [secondaryCharacterDescription, setSecondaryCharacterDescription] = useState("故事中的第二位固定角色，与主要人物有清楚区别，并在全部镜头中保持外貌、服装和体型一致");
  const [secondaryReferenceImage, setSecondaryReferenceImage] = useState<string>("");
  const [primaryGeneratedImage, setPrimaryGeneratedImage] = useState<string>("");
  const [secondaryGeneratedImage, setSecondaryGeneratedImage] = useState<string>("");
  const [manualCharacters, setManualCharacters] = useState<ManualCharacter[]>([]);
  const [characterPreview, setCharacterPreview] = useState<CharacterPreview | null>(null);
  const [shotSplitDraft, setShotSplitDraft] = useState<ShotSplitDraft | null>(null);
  const [shotCharacterLibraryDraft, setShotCharacterLibraryDraft] = useState<ShotCharacterLibraryDraft | null>(null);
  const [characterTask, setCharacterTask] = useState<"prompt" | "image" | null>(null);
  const [optimizingPromptShotId, setOptimizingPromptShotId] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [dataNoticeOpen, setDataNoticeOpen] = useState(false);
  const [generationNotice, setGenerationNotice] = useState<GenerationNotice | null>(null);
  const [generationProgress, setGenerationProgress] = useState<GenerationProgress | null>(null);
  const [storageInfo, setStorageInfo] = useState<StorageInfo | null>(null);
  const [generationAcknowledged, setGenerationAcknowledged] = useState(false);
  const pendingGeneration = useRef<(() => void) | null>(null);
  const [providers, setProviders] = useState<Providers>(() => normalizeProviders());
  const [appSettings, setAppSettings] = useState<AppSettings>(defaultAppSettings);
  const [testingConnection, setTestingConnection] = useState(false);
  const [editingProjectName, setEditingProjectName] = useState(false);
  const [projectNameDraft, setProjectNameDraft] = useState(projectName);
  const [voiceState, setVoiceState] = useState<AssetState>("idle");
  const [voiceUrl, setVoiceUrl] = useState("");
  const [voiceProvenance, setVoiceProvenance] = useState<VoiceProvenance | null>(null);
  const [voiceId, setVoiceId] = useState("marin");
  const [voiceTimelineAligned, setVoiceTimelineAligned] = useState(false);
  const [musicUrl, setMusicUrl] = useState("");
  const [musicName, setMusicName] = useState("");
  const [musicVolume, setMusicVolume] = useState(22);
  const [rendering, setRendering] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [captionsVisible, setCaptionsVisible] = useState(true);
  const [muted, setMuted] = useState(false);
  const [timelineZoom, setTimelineZoom] = useState(100);
  const [snapping, setSnapping] = useState(true);
  const [saveState, setSaveState] = useState<"dirty" | "saving" | "saved" | "error">("saving");
  const [lastSavedAt, setLastSavedAt] = useState("");
  const [saveRetry, setSaveRetry] = useState(0);
  const [undoClearedScript, setUndoClearedScript] = useState<string | null>(null);
  const [undoClearedStoryboard, setUndoClearedStoryboard] = useState<Shot[] | null>(null);
  const [characterError, setCharacterError] = useState("");
  const generationCancelRequested = useRef(false);
  const generationProgressSequence = useRef(0);
  const stoppedShotIds = useRef(new Set<string>());
  const fileInput = useRef<HTMLInputElement>(null);
  const characterInput = useRef<HTMLInputElement>(null);
  const secondaryCharacterInput = useRef<HTMLInputElement>(null);
  const manualCharacterInput = useRef<HTMLInputElement>(null);
  const manualCharacterImportTarget = useRef("");
  const musicInput = useRef<HTMLInputElement>(null);
  const projectPackageInput = useRef<HTMLInputElement>(null);
  const styleReferenceInput = useRef<HTMLInputElement>(null);
  const projectNameInput = useRef<HTMLInputElement>(null);
  const characterNameInput = useRef<HTMLInputElement>(null);
  const secondaryCharacterNameInput = useRef<HTMLInputElement>(null);
  const generationBackButton = useRef<HTMLButtonElement>(null);
  const dataNoticeCloseButton = useRef<HTMLButtonElement>(null);
  const playerFrame = useRef<HTMLDivElement>(null);
  const timelineViewport = useRef<HTMLDivElement>(null);
  const timelineContent = useRef<HTMLDivElement>(null);
  const voiceAudio = useRef<HTMLAudioElement>(null);
  const musicAudio = useRef<HTMLAudioElement>(null);

  const scriptBeats = creationMode === "short_drama" ? splitShortDramaBeats(script) : splitScriptIntoCinematicBeats(script, { pace });
  const draftDuration = creationMode === "short_drama"
    ? Math.max(8, Math.round(scriptBeats.reduce((sum, line) => sum + shortDramaDuration(line, shortDramaLineMetadata(line), pace), 0)))
    : Math.max(8, Math.round(script.replace(/\s/g, "").length / (pace === "舒缓" ? 3.2 : pace === "紧凑" ? 4.8 : 4)));
  const totalDuration = shots.reduce((sum, shot) => sum + shot.duration, 0) || draftDuration;
  const approvedCount = shots.filter((shot) => shot.approved).length;
  const allShotsApproved = shots.length > 0 && approvedCount === shots.length;
  const imageCount = shots.filter((shot) => shot.imageState === "ready").length;
  const videoCount = shots.filter((shot) => shot.videoState === "ready" && Boolean(shot.videoUrl)).length;
  const animatedImageCount = shots.filter((shot) => !(shot.videoState === "ready" && shot.videoUrl) && shot.imageState === "ready" && Boolean(shot.imageUrl)).length;
  const readyVisualCount = videoCount + animatedImageCount;
  const baseExportBlockReason = getExportBlockReason({ shots, script, voiceUrl });
  const exportBlockReason = voiceUrl && !voiceTimelineAligned ? "配音与字幕画面时间轴尚未对齐" : baseExportBlockReason;
  const currentShot = shots.find((shot) => playhead >= shot.start && playhead < shot.end) ?? shots[shots.length - 1];
  const activeStyle = videoStyles.find((option) => option.name === style) ?? videoStyles[0];
  const effectiveStyle = style === "自定义风格" && customStyle.trim() ? customStyle.trim() : activeStyle.prompt;
  const primaryCharacterAnalysis = useMemo(() => inferPrimaryCharacterProfile(script), [script]);
  const detectedDramaCharacters = useMemo(() => creationMode === "short_drama" ? extractShortDramaCharacters(script) : [], [creationMode, script]);
  const workflowSteps = useMemo(() => steps.map((step) => step.id === 1 ? { ...step, label: creationMode === "short_drama" ? "剧本" : "文稿", detail: creationMode === "short_drama" ? "场景、动作与对白" : "准备解说内容" } : step.id === 5 && creationMode === "short_drama" ? { ...step, detail: "对白轨与导出" } : step), [creationMode]);
  const primaryStages = primaryCharacterAnalysis.stages as CharacterStage[];
  const primaryCharacterPrompt = useMemo(() => buildCharacterPrompt({ name: characterName, description: characterDescription, stages: primaryStages }, effectiveStyle, Boolean(primaryGeneratedImage || referenceImage)), [characterName, characterDescription, primaryStages, effectiveStyle, primaryGeneratedImage, referenceImage]);
  const secondaryCharacterPrompt = useMemo(() => buildCharacterPrompt({ name: secondaryCharacterName, description: secondaryCharacterDescription, stages: ["adult"] }, effectiveStyle, Boolean(secondaryGeneratedImage || secondaryReferenceImage)), [secondaryCharacterName, secondaryCharacterDescription, effectiveStyle, secondaryGeneratedImage, secondaryReferenceImage]);
  const manualCharacterAnchors = useMemo(() => manualCharacters.filter((character) => character.enabled).map((character) => ({ id: character.id, name: character.name, description: character.description, masterImage: character.generatedImage || character.referenceImage || undefined, prompt: buildCharacterPrompt({ name: character.name, description: character.description, stages: ["adult"] }, effectiveStyle, Boolean(character.generatedImage || character.referenceImage)), aliases: [character.name], stages: ["adult" as CharacterStage], firstPerson: false })), [manualCharacters, effectiveStyle]);
  const activeCharacters = useMemo(() => [
    ...(characterEnabled ? [{ id: "primary" as const, name: characterName, description: characterDescription, masterImage: primaryGeneratedImage || referenceImage || undefined, prompt: primaryCharacterPrompt, aliases: primaryCharacterAnalysis.aliases, stages: primaryStages, firstPerson: primaryCharacterAnalysis.firstPerson }] : []),
    ...(secondaryCharacterEnabled ? [{ id: "secondary" as const, name: secondaryCharacterName, description: secondaryCharacterDescription, masterImage: secondaryGeneratedImage || secondaryReferenceImage || undefined, prompt: secondaryCharacterPrompt, aliases: [secondaryCharacterName], stages: ["adult" as CharacterStage], firstPerson: false }] : []),
    ...manualCharacterAnchors,
  ], [characterEnabled, characterName, characterDescription, referenceImage, primaryGeneratedImage, primaryCharacterPrompt, primaryCharacterAnalysis.aliases, primaryCharacterAnalysis.firstPerson, primaryStages, secondaryCharacterEnabled, secondaryCharacterName, secondaryCharacterDescription, secondaryReferenceImage, secondaryGeneratedImage, secondaryCharacterPrompt, manualCharacterAnchors]);
  const missingApprovedCharacterReferences = activeCharacters.filter((character) => !character.masterImage && shots.some((shot) => shot.approved && shot.characterIds?.includes(character.id)));
  const characterValidation = validateCharacterNames([
    { key: "primary", enabled: characterEnabled, name: characterName },
    { key: "secondary", enabled: secondaryCharacterEnabled, name: secondaryCharacterName },
    ...manualCharacters.map((character) => ({ key: character.id, enabled: character.enabled, name: character.name })),
  ]);
  const exportPayload = useMemo(() => ({ version: 12, projectId, projectName, creationMode, script, ratio, style, customStyle, customStyleReferenceImage, stylePrompt: effectiveStyle, pace, videoImageRole, characters: activeCharacters, manualCharacters, providers, shots, voiceUrl, voiceProvenance, voiceId, voiceTimelineAligned, musicUrl, musicName, musicVolume, activeStep }), [projectId, projectName, creationMode, script, ratio, style, customStyle, customStyleReferenceImage, effectiveStyle, pace, videoImageRole, activeCharacters, manualCharacters, providers, shots, voiceUrl, voiceProvenance, voiceId, voiceTimelineAligned, musicUrl, musicName, musicVolume, activeStep]);
  const exportPayloadString = useMemo(() => JSON.stringify(exportPayload, null, 2), [exportPayload]);

  useEffect(() => {
    const saved = window.localStorage.getItem("mujing-project-v1");
    if (!saved) { setHydrated(true); return; }
    try {
      const project = JSON.parse(saved);
      setProjectId(project.projectId ?? createProjectId());
      setProjectName(project.projectName ?? "雾中的小镇");
      setCreationMode(project.creationMode === "short_drama" ? "short_drama" : "narration");
      setScript(project.script ?? sampleScript);
      setRatio(project.ratio ?? "16:9");
      setStyle(project.style ?? "电影写实");
      setCustomStyle(project.customStyle ?? "");
      setCustomStyleReferenceImage(restoreLocalMediaUrl(project.customStyleReferenceImage));
      setPace(project.pace ?? "自然");
      setVideoImageRole(project.videoImageRole === "first_frame" ? "first_frame" : "reference_image");
      setShots((project.shots ?? []).map((shot: Shot) => {
        const imageInterrupted = ["submitting", "generating", "downloading"].includes(shot.imageState);
        const videoInterruptedWithoutTask = ["submitting", "generating", "downloading"].includes(shot.videoState) && !shot.videoTaskId;
        return { ...shot, imageUrl: restoreLocalMediaUrl(shot.imageUrl), videoUrl: restoreLocalMediaUrl(shot.videoUrl), imageState: imageInterrupted ? "error" : shot.imageState, videoState: shot.videoTaskId && ["submitting", "downloading"].includes(shot.videoState) ? "generating" : videoInterruptedWithoutTask ? "error" : shot.videoState, error: imageInterrupted || videoInterruptedWithoutTask ? "上次生成在提交前中断，请单独重试此镜头。" : shot.error };
      }));
      setCharacterName(project.characterName ?? "主要人物");
      setCharacterDescription(project.characterDescription ?? "");
      setCharacterEnabled(project.characterEnabled ?? true);
      setSecondaryCharacterName(project.secondaryCharacterName ?? "第二角色");
      setSecondaryCharacterDescription(project.secondaryCharacterDescription ?? "故事中的第二位固定角色，与主要人物有清楚区别，并在全部镜头中保持外貌、服装和体型一致");
      setSecondaryCharacterEnabled(project.secondaryCharacterEnabled ?? true);
      setReferenceImage(restoreLocalMediaUrl(project.referenceImage));
      setSecondaryReferenceImage(restoreLocalMediaUrl(project.secondaryReferenceImage));
      setPrimaryGeneratedImage(restoreLocalMediaUrl(project.primaryGeneratedImage));
      setSecondaryGeneratedImage(restoreLocalMediaUrl(project.secondaryGeneratedImage));
      setManualCharacters(Array.isArray(project.manualCharacters) ? project.manualCharacters.slice(0, 8).map((character: Partial<ManualCharacter>, index: number) => ({ id: /^extra-[a-z0-9-]{1,80}$/i.test(String(character.id || "")) ? String(character.id) : `extra-restored-${index + 1}`, name: String(character.name || `角色${index + 3}`), description: String(character.description || "固定角色，在所有相关镜头中保持外貌、服装与体型一致"), enabled: character.enabled !== false, referenceImage: restoreLocalMediaUrl(character.referenceImage), generatedImage: restoreLocalMediaUrl(character.generatedImage) })) : []);
      const persistedVoiceTrusted = Boolean(project.voiceUrl && project.voiceProvenance?.mediaId && project.voiceProvenance?.scriptSha256);
      setVoiceUrl(persistedVoiceTrusted ? restoreLocalMediaUrl(project.voiceUrl) : "");
      setVoiceProvenance(persistedVoiceTrusted ? project.voiceProvenance : null);
      setVoiceId(project.voiceId ?? "marin");
      const persistedShotDuration = (project.shots ?? []).reduce((sum: number, shot: Shot) => sum + Number(shot.duration || 0), 0);
      setVoiceTimelineAligned(Boolean(persistedVoiceTrusted && (project.voiceTimelineAligned === true || Math.abs(persistedShotDuration - Number(project.voiceProvenance?.duration || 0)) <= 0.15)));
      setVoiceState(persistedVoiceTrusted ? "ready" : "idle");
      if (project.voiceUrl && !persistedVoiceTrusted) setToast("旧项目缺少可信配音记录，请重新生成配音");
      setMusicUrl(restoreLocalMediaUrl(project.musicUrl));
      setMusicName(project.musicName ?? "");
      setMusicVolume(Math.max(0, Math.min(100, Number(project.musicVolume ?? 22))));
      setProviders(normalizeProviders(project.providers));
      setActiveStep(project.activeStep ?? 1);
    } catch { /* Ignore incomplete local drafts. */ }
    finally { setHydrated(true); }
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    setSaveState("dirty");
    const project = { projectId, projectName, creationMode, script, ratio, style, customStyle, customStyleReferenceImage, pace, videoImageRole, shots, characterEnabled, characterName, characterDescription, referenceImage, primaryGeneratedImage, secondaryCharacterEnabled, secondaryCharacterName, secondaryCharacterDescription, secondaryReferenceImage, secondaryGeneratedImage, manualCharacters, providers, voiceUrl, voiceProvenance, voiceId, voiceTimelineAligned, musicUrl, musicName, musicVolume, activeStep };
    let commitTimer = 0;
    const saveTimer = window.setTimeout(() => {
      setSaveState("saving");
      commitTimer = window.setTimeout(() => {
        try {
          window.localStorage.setItem("mujing-project-v1", JSON.stringify(project));
          const savedAt = new Date().toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" });
          setLastSavedAt(savedAt);
          setSaveState("saved");
        } catch {
          setSaveState("error");
          setToast("保存失败，修改仍保留在当前页面；请点击重试或另存 .story 项目制作包");
        }
      }, 60);
    }, 500);
    return () => { window.clearTimeout(saveTimer); window.clearTimeout(commitTimer); };
  }, [hydrated, projectId, projectName, creationMode, script, ratio, style, customStyle, customStyleReferenceImage, pace, videoImageRole, shots, characterEnabled, characterName, characterDescription, referenceImage, primaryGeneratedImage, secondaryCharacterEnabled, secondaryCharacterName, secondaryCharacterDescription, secondaryReferenceImage, secondaryGeneratedImage, manualCharacters, providers, voiceUrl, voiceProvenance, voiceId, voiceTimelineAligned, musicUrl, musicName, musicVolume, activeStep, saveRetry]);

  useEffect(() => {
    if (!window.mujingDesktop) return;
    void window.mujingDesktop.getAppVersion().then((version) => setAppVersion(String(version || "").trim())).catch(() => setAppVersion(""));
    void window.mujingDesktop.getSettings().then((settings) => setAppSettings({
      mode: settings.mode,
      openai: { ...defaultAppSettings.openai, ...settings.openai, apiKey: "", clearApiKey: false },
      custom: { ...defaultAppSettings.custom, ...settings.custom, apiKey: "", clearApiKey: false },
      elevenlabs: { ...defaultAppSettings.elevenlabs, ...settings.elevenlabs, apiKey: "", clearApiKey: false },
      comfyui: { ...defaultAppSettings.comfyui, ...settings.comfyui, apiKey: "", clearApiKey: false },
    })).catch(() => setToast("API 设置读取失败，请重新保存"));
    void window.mujingDesktop.getStorageInfo().then(setStorageInfo).catch(() => setToast("本地存储路径读取失败"));
  }, []);

  useEffect(() => {
    if (!hydrated || !window.mujingDesktop) return;
    setPaidTaskJournalReady(false);
    void window.mujingDesktop.getPaidVideoTasks(projectId).then((entries) => {
      const entriesByShot = new Map<string, PaidTaskJournalEntry[]>();
      for (const entry of entries) {
        const current = entriesByShot.get(entry.shotId) || [];
        current.push(entry);
        entriesByShot.set(entry.shotId, current);
      }
      setShots((items) => {
        let changed = false;
        const recovered = items.map((shot) => {
          const shotEntries = (entriesByShot.get(shot.id) || [])
            .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)) || Number(right.attempt || 0) - Number(left.attempt || 0));
          const entry = shotEntries[0];
          if (!entry) return shot;
          const uncertainEntry = shotEntries.find((candidate) => !candidate.taskId && ["submission_pending", "unknown"].includes(candidate.status));
          const taskEntry = shotEntries.find((candidate) => Boolean(candidate.taskId) && isPaidJournalEntryUnresolved(candidate));
          if (taskEntry?.taskId && !String(taskEntry.provider || "").trim()) {
            changed = true;
            return { ...shot, videoTaskId: taskEntry.taskId, videoTaskProvider: undefined, videoSubmissionRisk: Boolean(uncertainEntry), videoState: "error", error: "旧项目缺少原服务商，无法安全轮询；未向当前服务商发送请求。" };
          }
          if (taskEntry?.taskId && (shot.videoTaskId !== taskEntry.taskId || shot.videoTaskProvider !== taskEntry.provider || shot.videoSubmissionRisk !== Boolean(uncertainEntry))) {
            changed = true;
            return { ...shot, videoTaskId: taskEntry.taskId, videoTaskProvider: taskEntry.provider, videoSubmissionRisk: Boolean(uncertainEntry), videoState: taskEntry.status === "completed" && shot.videoUrl ? "ready" : "generating", error: uncertainEntry ? "已恢复可轮询的任务 ID；另有旧请求仍处于未知受理状态，记录已保留。" : "已从主进程付费任务记录恢复任务 ID；继续操作只会轮询原任务。" };
          }
          if (uncertainEntry && (shot.videoState !== "error" || !shot.videoSubmissionRisk)) {
            changed = true;
            return { ...shot, videoState: "error", videoSubmissionRisk: true, error: "服务商可能已受理上次请求但未返回可靠任务 ID，已阻止自动重提。" };
          }
          if (!taskEntry && entry.status === "rejected") {
            changed = true;
            return { ...shot, videoState: "error", videoSubmissionRisk: false, error: providerHttpRejectionMessage(entry.httpStatus, entry.providerCode, entry.requestId) };
          }
          if (!taskEntry && ["failed", "canceled", "abandoned"].includes(entry.status) && shot.videoTaskId) {
            changed = true;
            return { ...shot, videoTaskId: undefined, videoTaskProvider: undefined, videoSubmissionRisk: false, videoState: entry.status === "failed" ? "error" : "canceled", error: entry.status === "abandoned" ? "已放弃本地等待并解除编辑锁；原任务审计记录仍保留。" : `原视频任务已${entry.status === "canceled" ? "取消" : "失败"}，编辑锁已自动解除。` };
          }
          return shot;
        });
        return changed ? recovered : items;
      });
      setPaidTaskJournalReady(true);
    }).catch(() => {
      setPaidTaskJournalReady(false);
      setToast("付费任务记录读取失败；为避免输入漂移或重复计费，已锁定相关编辑与视频恢复");
    });
  }, [hydrated, projectId]);

  useEffect(() => {
    if (!window.mujingDesktop) return;
    return window.mujingDesktop.onAssetProgress((progress) => {
      setShots((items) => items.map((shot) => {
        if (progress.shotId !== shot.id && (!progress.jobId || progress.jobId !== shot.videoTaskId)) return shot;
        return { ...shot, [progress.kind === "image" ? "imageState" : "videoState"]: progress.status };
      }));
      setGenerationProgress((current) => current?.status === "running" && /图片|视频|镜头/.test(current.title)
        ? { ...current, detail: `${progress.shotId ? `镜头 ${progress.shotId.replace("shot-", "")}` : "当前任务"}：${assetStateLabel(progress.status)}` }
        : current);
    });
  }, []);

  useEffect(() => { if (generationNotice) generationBackButton.current?.focus(); }, [generationNotice]);
  useEffect(() => { if (dataNoticeOpen) dataNoticeCloseButton.current?.focus(); }, [dataNoticeOpen]);

  useEffect(() => {
    if (!editingProjectName) return;
    projectNameInput.current?.focus();
    projectNameInput.current?.select();
  }, [editingProjectName]);

  useEffect(() => {
    if (!generationNotice && !dataNoticeOpen) return;
    const frame = window.requestAnimationFrame(() => {
      const selector = generationNotice ? ".generation-notice-modal input" : ".data-notice-modal .modal-close";
      document.querySelector<HTMLElement>(selector)?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [generationNotice, dataNoticeOpen]);

  useEffect(() => {
    function closeDialog(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (generationNotice) { pendingGeneration.current = null; setGenerationNotice(null); }
      else if (dataNoticeOpen) setDataNoticeOpen(false);
      else if (settingsOpen) setSettingsOpen(false);
      else if (styleOpen) setStyleOpen(false);
      else if (characterPreview) setCharacterPreview(null);
      else if (exportOpen && !rendering) setExportOpen(false);
    }
    window.addEventListener("keydown", closeDialog);
    return () => window.removeEventListener("keydown", closeDialog);
  }, [generationNotice, dataNoticeOpen, settingsOpen, styleOpen, characterPreview, exportOpen, rendering]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(""), 2600);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    if (!generationProgress || generationProgress.status === "running") return;
    const timeout = window.setTimeout(() => setGenerationProgress((current) => current?.id === generationProgress.id ? null : current), generationProgress.status === "success" ? 4200 : 7200);
    return () => window.clearTimeout(timeout);
  }, [generationProgress]);

  useEffect(() => {
    if (!playing || voiceUrl) return;
    const timer = window.setInterval(() => {
      setPlayhead((value) => {
        if (value + 0.25 >= totalDuration) {
          setPlaying(false);
          return 0;
        }
        return value + 0.25;
      });
    }, 250);
    return () => window.clearInterval(timer);
  }, [playing, totalDuration, voiceUrl]);

  useEffect(() => {
    const audio = voiceAudio.current;
    if (!audio || !voiceUrl) return;
    audio.muted = muted;
    if (playing) {
      void audio.play().catch(() => setPlaying(false));
    } else audio.pause();
  }, [playing, muted, voiceUrl]);

  useEffect(() => {
    const audio = musicAudio.current;
    if (!audio || !musicUrl) return;
    audio.muted = muted;
    audio.volume = musicVolume / 100;
    if (playing) {
      const target = Number.isFinite(audio.duration) && audio.duration > 0 ? playhead % audio.duration : playhead;
      if (Math.abs(audio.currentTime - target) > .8) audio.currentTime = target;
      void audio.play().catch(() => setPlaying(false));
    } else audio.pause();
  }, [playing, muted, musicUrl, musicVolume, playhead]);

  function seekTimeline(value: number) {
    const clamped = Math.max(0, Math.min(totalDuration, value));
    const boundaries = shots.flatMap((shot) => [shot.start, shot.end]);
    const resolved = snapping && boundaries.length ? boundaries.reduce((best, point) => Math.abs(point - clamped) < Math.abs(best - clamped) && Math.abs(point - clamped) < .7 ? point : best, clamped) : clamped;
    setPlayhead(resolved);
    if (voiceAudio.current && voiceUrl) voiceAudio.current.currentTime = resolved;
    if (musicAudio.current && musicUrl) {
      const duration = musicAudio.current.duration;
      musicAudio.current.currentTime = Number.isFinite(duration) && duration > 0 ? resolved % duration : resolved;
    }
  }

  function toggleTimelinePlayback() {
    if (!playing && playhead >= totalDuration - .01) seekTimeline(0);
    setPlaying((current) => !current);
  }

  function changeTimelineZoom(delta: number, anchorClientX?: number) {
    const nextZoom = Math.max(60, Math.min(300, timelineZoom + delta));
    if (nextZoom === timelineZoom) return;
    const viewport = timelineViewport.current;
    const content = timelineContent.current;
    if (!viewport || !content) {
      setTimelineZoom(nextZoom);
      return;
    }
    const viewportRect = viewport.getBoundingClientRect();
    const anchorX = Math.max(0, Math.min(viewportRect.width, anchorClientX === undefined ? viewportRect.width / 2 : anchorClientX - viewportRect.left));
    const oldWidth = content.getBoundingClientRect().width;
    const anchorRatio = oldWidth > 0 ? (viewport.scrollLeft + anchorX) / oldWidth : .5;
    setTimelineZoom(nextZoom);
    window.requestAnimationFrame(() => {
      const newWidth = timelineContent.current?.getBoundingClientRect().width ?? oldWidth;
      viewport.scrollLeft = Math.max(0, anchorRatio * newWidth - anchorX);
    });
  }

  function zoomTimelineWithWheel(event: ReactWheelEvent<HTMLDivElement>) {
    event.preventDefault();
    const wheelDelta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
    if (!wheelDelta) return;
    changeTimelineZoom(wheelDelta < 0 ? 10 : -10, event.clientX);
  }

  useEffect(() => {
    function togglePlaybackWithSpace(event: KeyboardEvent) {
      if (event.code !== "Space" || event.repeat || activeStep !== 5) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("input, textarea, select, button, a, [contenteditable='true'], [role='textbox']")) return;
      if (document.querySelector(".modal-backdrop")) return;
      event.preventDefault();
      toggleTimelinePlayback();
    }
    window.addEventListener("keydown", togglePlaybackWithSpace);
    return () => window.removeEventListener("keydown", togglePlaybackWithSpace);
  }, [activeStep, playing, playhead, totalDuration]);

  const progress = useMemo(() => {
    if (activeStep === 1) return 20;
    if (activeStep === 2) return 35;
    if (activeStep === 3) return Math.round(45 + (approvedCount / Math.max(shots.length, 1)) * 15);
    if (activeStep === 4) return Math.round(60 + ((imageCount + readyVisualCount) / Math.max(shots.length * 2, 1)) * 25);
    return 100;
  }, [activeStep, approvedCount, shots.length, imageCount, readyVisualCount]);

  function generationModel(provider: string, kind: "storyboard" | "image" | "video" | "voice") {
    const config = provider === "本地 ComfyUI" ? appSettings.comfyui : /ElevenLabs/i.test(provider) ? appSettings.elevenlabs : /OpenAI/i.test(provider) ? appSettings.openai : appSettings.custom;
    return kind === "storyboard" ? config.storyboardModel : kind === "image" ? config.imageModel : kind === "video" ? config.videoModel : config.voiceModel;
  }

  function activeVideoPromptModel() {
    const model = generationModel(providers.video, "video");
    if (providers.video !== "本地 ComfyUI" || model !== "custom-workflow") return model;
    const workflowName = appSettings.comfyui.workflowPath.split(/[\\/]/).pop();
    return workflowName ? `custom-workflow:${workflowName}` : model;
  }

  function beginGenerationProgress(title: string, total = 1, detail = "正在准备生成请求…") {
    const id = ++generationProgressSequence.current;
    setGenerationProgress({ id, title, detail, status: "running", current: 0, total: Math.max(1, total) });
    return id;
  }

  function updateGenerationProgress(id: number, changes: Partial<Pick<GenerationProgress, "detail" | "current" | "total">>) {
    setGenerationProgress((current) => current?.id === id && current.status === "running" ? { ...current, ...changes } : current);
  }

  function finishGenerationProgress(id: number, detail: string) {
    setGenerationProgress((current) => current?.id === id ? { ...current, detail, status: "success", current: current.total } : current);
  }

  function failGenerationProgress(id: number, detail: string) {
    setGenerationProgress((current) => current?.id === id ? { ...current, detail, status: "error" } : current);
  }

  function cancelGenerationProgress(id: number, detail: string) {
    setGenerationProgress((current) => current?.id === id ? { ...current, detail, status: "canceled" } : current);
  }

  function requestGeneration(details: { title: string; model: string; provider: string; itemCount: number; uploads: string }, action: () => void) {
    if (appSettings.mode === "demo") { action(); return; }
    pendingGeneration.current = action;
    setGenerationAcknowledged(false);
    setGenerationNotice(buildGenerationNotice(details));
  }

  function confirmGeneration() {
    if (!generationAcknowledged) return;
    const action = pendingGeneration.current;
    pendingGeneration.current = null;
    setGenerationNotice(null);
    action?.();
  }

  function validateCharactersForGeneration() {
    const validation = validateCharacterNames([
      { key: "primary", enabled: characterEnabled, name: characterName },
      { key: "secondary", enabled: secondaryCharacterEnabled, name: secondaryCharacterName },
      ...manualCharacters.map((character) => ({ key: character.id, enabled: character.enabled, name: character.name })),
    ]);
    if (validation.ok) { setCharacterError(""); return true; }
    const fallbackMessage = "角色称呼不能为空，也不能使用“主要人物”或“第二角色”等占位名称；角色称呼不能重复。请修改后再生成。";
    setCharacterError(validation.message || fallbackMessage);
    setActiveStep(2);
    if (validation.invalidKey === "primary" || validation.invalidKey === "secondary") window.setTimeout(() => (validation.invalidKey === "primary" ? characterNameInput : secondaryCharacterNameInput).current?.focus(), 0);
    setToast(validation.invalidKey === "primary" ? "已定位到主要角色称呼，请修改后继续" : validation.invalidKey === "secondary" ? "已定位到第二角色称呼，请修改后继续" : "请修改新增角色的称呼后继续");
    return false;
  }

  async function identifyCharactersAndContinue() {
    if (script.trim().length < 12) { setToast(creationMode === "short_drama" ? "请先输入包含场景、动作或对白的短剧剧本" : "请先输入一段完整的解说文稿"); return; }
    if (shots.length && !await ensurePaidTasksAllow("character-profile-change")) return;
    const progressId = beginGenerationProgress("识别文稿角色", 1, "正在分析人物关系与主角身份…");
    const inferredProfile = inferPrimaryCharacterProfile(script);
    const dramaNames = creationMode === "short_drama" ? extractShortDramaCharacters(script) : [];
    const inferredName = dramaNames[0] || inferredProfile.name;
    const resolvedName = inferredName && PLACEHOLDER_CHARACTER_NAMES.has(characterName.trim()) ? inferredName : characterName;
    const resolvedDescription = inferredName && (PLACEHOLDER_CHARACTER_NAMES.has(characterName.trim()) || isGenericPrimaryDescription(characterDescription))
      ? createDemoCharacterDescription({ name: resolvedName, script })
      : characterDescription;
    const inferredSecondaryName = dramaNames[1] || inferSecondaryCharacterName(script, resolvedName);
    const resolvedSecondaryName = inferredSecondaryName && PLACEHOLDER_CHARACTER_NAMES.has(secondaryCharacterName.trim()) ? inferredSecondaryName : secondaryCharacterName;
    setCharacterName(resolvedName);
    setCharacterDescription(resolvedDescription);
    setSecondaryCharacterName(resolvedSecondaryName);
    setSecondaryCharacterEnabled(creationMode === "short_drama" ? Boolean(inferredSecondaryName) : secondaryCharacterEnabled && Boolean(inferredSecondaryName || !PLACEHOLDER_CHARACTER_NAMES.has(resolvedSecondaryName.trim())));
    if (inferredSecondaryName && PLACEHOLDER_CHARACTER_NAMES.has(secondaryCharacterName.trim())) setSecondaryCharacterDescription(`${inferredSecondaryName}，故事中的第二位固定角色；与${resolvedName}有明显外观差异，并保持发型、服装与体型一致`);
    if (creationMode === "short_drama" && dramaNames.length > 2) {
      const existingByName = new Map(manualCharacters.map((character) => [character.name, character]));
      const additions = dramaNames.slice(2, 10).map((name, index) => existingByName.get(name) || ({ id: `extra-drama-${Date.now().toString(36)}-${index}`, name, description: `${name}，短剧中的固定配角；请补充面部、发型、服装、体型和标志性物品，并在相关镜头中保持一致`, enabled: true, referenceImage: "", generatedImage: "" }));
      const retained = manualCharacters.filter((character) => !dramaNames.includes(character.name));
      setManualCharacters([...additions, ...retained].slice(0, 8));
    }
    setCharacterError("");
    setActiveStep(2);
    finishGenerationProgress(progressId, `已找到主角“${resolvedName}”${inferredSecondaryName ? `和第二角色“${resolvedSecondaryName}”` : ""}${dramaNames.length > 2 ? `，共 ${dramaNames.length} 个有名角色` : ""}`);
    setToast(`已从文稿找到主角“${resolvedName}”${inferredProfile.stages.length > 1 ? "，并识别出跨年龄阶段" : ""}；请先锁定主角母版再生成画面`);
  }

  function updateScript(nextScript: string, invalidationMessage = "文稿已修改，原配音已失效，请按当前完整文稿重新生成配音") {
    const changed = nextScript !== script;
    setScript(nextScript);
    if (changed && voiceUrl) {
      voiceAudio.current?.pause();
      setPlaying(false);
      setVoiceUrl("");
      setVoiceProvenance(null);
      setVoiceTimelineAligned(false);
      setVoiceState("idle");
      setToast(invalidationMessage);
      return true;
    }
    return false;
  }

  async function updateCreationMode(nextMode: CreationMode) {
    if (nextMode === creationMode) return;
    if (shots.length && !await ensurePaidTasksAllow("storyboard-redesign")) return;
    if (shots.length && !window.confirm("切换创作模式会清空当前分镜，但会保留剧本、角色和已保存的本地素材。是否继续？")) return;
    setCreationMode(nextMode);
    setShots([]);
    setActiveStep(1);
    setToast(nextMode === "short_drama" ? "已进入短剧模式；可在右侧自由选择竖版或横版" : "已切换为解说视频模式");
  }

  async function loadShortDramaExample() {
    if (shots.length && !await ensurePaidTasksAllow("storyboard-redesign")) return;
    if (script.trim() && script !== sampleScript && script !== sampleShortDramaScript && !window.confirm("载入示例会替换当前剧本，是否继续？")) return;
    setCreationMode("short_drama");
    setShots([]);
    updateScript(sampleShortDramaScript, "已载入短剧示例，原配音已失效");
    setProjectName("会议室的选择");
    setProjectNameDraft("会议室的选择");
    setToast("已载入短剧示例，可直接修改场景、动作和角色对白");
  }

  function clearScript() {
    if (!script || !window.confirm("清空解说文稿会移除当前全部文字，但不会删除已生成素材。是否继续？")) return;
    setUndoClearedScript(script);
    const invalidated = updateScript("", "文稿已清空，原配音已失效，请重新生成配音");
    if (invalidated) return;
    setToast("文稿已清空，本会话可撤销一次");
  }

  function restoreClearedScript() {
    if (undoClearedScript === null) return;
    updateScript(undoClearedScript, "已撤销清空；原配音仍已失效，请重新生成配音");
    setUndoClearedScript(null);
    setToast("已撤销清空");
  }

  function retrySave() { setSaveRetry((value) => value + 1); }

  type PaidInputAction = "style-change" | "ratio-change" | "visual-change" | "character-stage-change" | "first-frame-change" | "character-profile-change" | "image-regeneration" | "storyboard-clear" | "storyboard-redesign";

  function allowPaidInputChange(action: PaidInputAction, shotId?: string) {
    const localGuard = guardPaidTaskDestruction(shots, action, shotId);
    if (!localGuard.allowed) {
      setBlockedPaidTask({ shotId: localGuard.task.id, provider: localGuard.task.videoTaskProvider, status: localGuard.task.videoState || "active", taskId: localGuard.task.videoTaskId, reason: localGuard.reason });
      setToast(localGuard.reason);
      return false;
    }
    if (window.mujingDesktop && !paidTaskJournalReady) {
      setToast("正在核验主进程付费任务记录；完成前已锁定会改变视频任务输入的编辑。");
      return false;
    }
    return true;
  }

  async function ensurePaidTasksAllow(action: PaidInputAction, shotId?: string) {
    const localGuard = guardPaidTaskDestruction(shots, action, shotId);
    if (!localGuard.allowed) {
      setBlockedPaidTask({ shotId: localGuard.task.id, provider: localGuard.task.videoTaskProvider, status: localGuard.task.videoState || "active", taskId: localGuard.task.videoTaskId, reason: localGuard.reason });
      setToast(localGuard.reason);
      return false;
    }
    if (!window.mujingDesktop) return true;
    try {
      const entries = await window.mujingDesktop.getPaidVideoTasks(projectId);
      const unresolved = entries.find((entry) => (!shotId || entry.shotId === shotId) && isPaidJournalEntryUnresolved(entry));
      if (unresolved) {
        setBlockedPaidTask({ shotId: unresolved.shotId, provider: unresolved.provider, status: unresolved.status, taskId: unresolved.taskId, reason: `镜头 ${unresolved.shotId} 的付费视频任务仍未解决。` });
        setToast(`镜头 ${unresolved.shotId} 的主进程付费任务记录仍未解决。请先继续轮询原任务；已阻止当前操作。`);
        return false;
      }
      return true;
    } catch {
      setToast("无法核验主进程付费任务记录；为避免丢失收费任务，已阻止当前操作。");
      return false;
    }
  }

  async function abandonBlockedPaidTask() {
    if (!blockedPaidTask || !window.mujingDesktop) return;
    try {
      const result = await window.mujingDesktop.abandonPaidVideoTask({ projectId, shotId: blockedPaidTask.shotId });
      if (!result.abandoned) { setToast("已返回，任务锁仍然保留"); return; }
      setShots((items) => items.map((shot) => shot.id === blockedPaidTask.shotId ? {
        ...shot,
        videoTaskId: undefined,
        videoTaskProvider: undefined,
        videoSubmissionRisk: false,
        videoState: "canceled",
        error: result.remoteMayContinue ? "已放弃本地等待并解除编辑锁；远端任务可能仍继续运行和计费。" : "已放弃本地等待并解除编辑锁。",
      } : shot));
      setBlockedPaidTask(null);
      setToast(result.remoteMayContinue ? "已解除编辑锁；Seedance 远端任务可能仍继续运行和计费" : "已放弃等待并解除编辑锁");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "解除付费任务锁失败");
    }
  }

  function continueBlockedPaidTask() {
    if (!blockedPaidTask?.taskId) return;
    const shotId = blockedPaidTask.shotId;
    setBlockedPaidTask(null);
    setActiveStep(4);
    window.setTimeout(() => { void generateAssets("video", shotId); }, 0);
  }

  async function confirmClearStoryboard() {
    if (!shots.length) return;
    if (!await ensurePaidTasksAllow("storyboard-clear")) return;
    const prepared = prepareStoryboardClear(shots);
    if (!prepared.allowed) { setToast(prepared.reason); return; }
    if (!window.confirm("清空全部分镜会从当前项目移除镜头描述、确认状态、素材引用和已完成任务显示；主进程付费任务记录不会删除。本会话可撤销最近一次清空。是否继续？")) return;
    setUndoClearedStoryboard(prepared.snapshot);
    setShots(prepared.nextShots);
    setToast("全部分镜已清空；本会话可撤销最近一次清空，付费任务记录未删除");
  }

  function restoreClearedStoryboard() {
    if (!undoClearedStoryboard) return;
    setShots(restoreStoryboardSnapshot(undoClearedStoryboard));
    setUndoClearedStoryboard(null);
    setActiveStep(3);
    setToast("已撤销清空全部分镜，镜头描述、素材引用和任务 ID 均已恢复");
  }

  async function redesignStoryboard() {
    if (!await ensurePaidTasksAllow("storyboard-redesign")) return;
    if (!window.confirm("重新设计会替换当前全部分镜及其确认状态，但不会删除本地媒体缓存或已导出的 MP4。是否继续？")) return;
    const progressId = beginGenerationProgress("重新设计电影分镜", 1, "正在重新安排叙事节奏、景别与运镜…");
    setShots(buildShots(script, { style: effectiveStyle, ratio, pace, characters: activeCharacters, creationMode }));
    finishGenerationProgress(progressId, "分镜已重新设计，请逐个检查并确认");
    setToast("已重新设计全部分镜，请逐个确认后再生成");
  }

  async function cancelQueuedGeneration() {
    generationCancelRequested.current = true;
    const localTasks = shots.filter((shot) => shot.videoTaskProvider === "本地 ComfyUI" && shot.videoTaskId && ["submitting", "generating", "downloading"].includes(shot.videoState));
    await Promise.allSettled(localTasks.map((shot) => window.mujingDesktop?.cancelVideoTask({ provider: "本地 ComfyUI", jobId: shot.videoTaskId })));
    for (const shot of localTasks) updateShot(shot.id, { videoState: "canceled", videoTaskId: undefined, videoTaskProvider: undefined, videoSubmissionRisk: false, error: "已中断本地 ComfyUI 任务。" });
    const remote = shots.some((shot) => shot.videoTaskProvider && shot.videoTaskProvider !== "本地 ComfyUI" && shot.videoTaskId);
    setGenerationProgress((current) => current?.status === "running" ? { ...current, status: "canceled", detail: remote ? "本地队列已停止；云端任务可能仍在运行" : "本地队列与 ComfyUI 任务已停止" } : current);
    setToast(remote ? "本地队列已停止；云端任务可能继续并计费" : "已停止本地队列与 ComfyUI 当前任务");
  }

  async function stopShotGeneration(shot: Shot) {
    stoppedShotIds.current.add(shot.id);
    if (shot.videoTaskProvider === "本地 ComfyUI" && shot.videoTaskId && window.mujingDesktop) {
      try { await window.mujingDesktop.cancelVideoTask({ provider: "本地 ComfyUI", jobId: shot.videoTaskId }); } catch { /* UI state is still released. */ }
      updateShot(shot.id, { videoState: "canceled", videoTaskId: undefined, videoTaskProvider: undefined, videoSubmissionRisk: false, error: "已中断本地 ComfyUI 任务。" });
      setToast("已中断该镜头的本地 ComfyUI 任务");
      return;
    }
    if (shot.videoTaskId) updateShot(shot.id, stopShotLocally(shot));
    else if (shot.videoState === "submitting") updateShot(shot.id, { videoState: "canceled", error: "正在停止本地等待；请求可能已到达服务商，若返回任务 ID 将保留并停止轮询。" });
    else updateShot(shot.id, stopShotLocally(shot));
    setToast(shot.videoTaskId ? "仅停止本地轮询；远端任务可能继续并计费，任务 ID 已保留" : "已停止该镜头的本地排队");
  }

  function runGenerateStoryboard(noticeConfirmed = false) {
    void handleGenerateStoryboard(noticeConfirmed).catch((error) => {
      const message = error instanceof Error ? error.message : "分镜生成失败，请检查 API 设置";
      setBusy(false);
      const progressId = beginGenerationProgress("生成电影叙事分镜", 1, "分镜生成未能启动");
      failGenerationProgress(progressId, message);
      setToast(message);
    });
  }

  async function handleGenerateStoryboard(noticeConfirmed = false) {
    if (script.trim().length < 12) {
      setToast(creationMode === "short_drama" ? "请先输入完整的短剧剧本" : "请先输入一段完整的解说文稿");
      return;
    }
    const inferredProfile = inferPrimaryCharacterProfile(script);
    const dramaNames = creationMode === "short_drama" ? extractShortDramaCharacters(script) : [];
    const inferredName = dramaNames[0] || inferredProfile.name;
    const resolvedName = inferredName && PLACEHOLDER_CHARACTER_NAMES.has(characterName.trim()) ? inferredName : characterName;
    const resolvedDescription = inferredName && (PLACEHOLDER_CHARACTER_NAMES.has(characterName.trim()) || isGenericPrimaryDescription(characterDescription))
      ? createDemoCharacterDescription({ name: resolvedName, script })
      : characterDescription;
    const inferredSecondaryName = dramaNames[1] || inferSecondaryCharacterName(script, resolvedName);
    const resolvedSecondaryName = inferredSecondaryName && PLACEHOLDER_CHARACTER_NAMES.has(secondaryCharacterName.trim()) ? inferredSecondaryName : secondaryCharacterName;
    const resolvedSecondaryEnabled = creationMode === "short_drama" ? Boolean(inferredSecondaryName) : secondaryCharacterEnabled && (Boolean(inferredSecondaryName) || !PLACEHOLDER_CHARACTER_NAMES.has(resolvedSecondaryName.trim()));
    const resolvedSecondaryDescription = inferredSecondaryName && PLACEHOLDER_CHARACTER_NAMES.has(secondaryCharacterName.trim())
      ? `${inferredSecondaryName}，故事中的第二位固定角色；与${resolvedName}有明显外观差异，并保持发型、服装与体型一致`
      : secondaryCharacterDescription;
    const validation = validateCharacterNames([
      { key: "primary", enabled: characterEnabled, name: resolvedName },
      { key: "secondary", enabled: resolvedSecondaryEnabled, name: resolvedSecondaryName },
      ...manualCharacters.map((character) => ({ key: character.id, enabled: character.enabled, name: character.name })),
    ]);
    if (!validation.ok) {
      setCharacterError(validation.message || "角色称呼不能为空，也不能使用“主要人物”或“第二角色”等占位名称；角色称呼不能重复。请修改后再生成。");
      setActiveStep(2);
      if (validation.invalidKey === "primary" || validation.invalidKey === "secondary") window.setTimeout(() => (validation.invalidKey === "primary" ? characterNameInput : secondaryCharacterNameInput).current?.focus(), 0);
      return;
    }
    if (shots.length && !await ensurePaidTasksAllow("storyboard-redesign")) return;
    if (appSettings.mode === "live" && !noticeConfirmed) {
      requestGeneration({ title: creationMode === "short_drama" ? "生成短剧叙事分镜" : "生成电影叙事分镜", model: generationModel(providers.storyboard, "storyboard"), provider: providers.storyboard, itemCount: Math.max(1, scriptBeats.length), uploads: `${creationMode === "short_drama" ? "完整短剧剧本、场景、动作、说话人与对白" : "完整解说文稿"}、画面比例、叙事节奏、全片风格与已启用的角色档案（角色参考图不会用于分镜文本设计）` }, () => runGenerateStoryboard(true));
      return;
    }
    const progressId = beginGenerationProgress(creationMode === "short_drama" ? "生成短剧叙事分镜" : "生成电影叙事分镜", 1, creationMode === "short_drama" ? "正在识别场景、说话人、对白、表演节拍和群众调度…" : "正在理解文稿、划分叙事节拍与设计镜头语言…");
    setBusy(true);
    try {
      setCharacterName(resolvedName);
      setCharacterDescription(resolvedDescription);
      setSecondaryCharacterName(resolvedSecondaryName);
      setSecondaryCharacterDescription(resolvedSecondaryDescription);
      setSecondaryCharacterEnabled(resolvedSecondaryEnabled);
      const characters = [
        ...(characterEnabled ? [{ id: "primary" as const, name: resolvedName, description: resolvedDescription, masterImage: primaryGeneratedImage || referenceImage || undefined, prompt: buildCharacterPrompt({ name: resolvedName, description: resolvedDescription, stages: inferredProfile.stages as CharacterStage[] }, effectiveStyle, Boolean(primaryGeneratedImage || referenceImage)), aliases: inferredProfile.aliases, stages: inferredProfile.stages as CharacterStage[], firstPerson: inferredProfile.firstPerson }] : []),
        ...(resolvedSecondaryEnabled ? [{ id: "secondary" as const, name: resolvedSecondaryName, description: resolvedSecondaryDescription, masterImage: secondaryGeneratedImage || secondaryReferenceImage || undefined, prompt: buildCharacterPrompt({ name: resolvedSecondaryName, description: resolvedSecondaryDescription, stages: ["adult"] }, effectiveStyle, Boolean(secondaryGeneratedImage || secondaryReferenceImage)), aliases: [resolvedSecondaryName], stages: ["adult" as CharacterStage], firstPerson: false }] : []),
        ...manualCharacterAnchors,
      ];
      let nextShots: Shot[];
      if (appSettings.mode === "live") {
        if (!window.mujingDesktop) throw new Error("真实模型仅在安装版中可用，请打开幕境桌面应用。");
        const storyboardCharacters = characters.map(({ id, name, description }) => ({ id, name, description }));
        const result = await window.mujingDesktop.createStoryboard({ provider: providers.storyboard, videoProvider: providers.video, videoModel: activeVideoPromptModel(), videoImageRole, creationMode, script, ratio, style: effectiveStyle, pace, characters: storyboardCharacters });
        let cursor = 0;
        let currentDramaScene = "";
        nextShots = result.shots.map((item, index) => {
          const narration = String(item.narration || "").trim() || script.split(/(?<=[。！？!?])/)[index]?.trim() || `镜头 ${index + 1}`;
          const dramaMetadata = creationMode === "short_drama" ? shortDramaLineMetadata(narration, currentDramaScene) : { kind: "narration", scene: "", speaker: "", dialogue: "", extras: "" };
          const returnedScene = String(item.scene || dramaMetadata.scene || currentDramaScene).trim();
          if (creationMode === "short_drama" && returnedScene) currentDramaScene = returnedScene;
          const plan = creationMode === "short_drama" ? shortDramaShotPlan(index, dramaMetadata) : cinematicShotPlan(index);
          const durationFloor = creationMode === "short_drama" ? 1.8 : 2.2;
          const duration = Math.round(Math.max(durationFloor, Math.min(5.5, Number(item.duration) || (creationMode === "short_drama" ? shortDramaDuration(narration, dramaMetadata, pace) : cinematicDuration(narration, { shotType: String(item.shotType || plan.shotType), pace })))) * 10) / 10;
          const referencedCharacters = charactersForNarration(narration, characters);
          const characterAnchor = compileCharacterAnchor(referencedCharacters, narration);
          const performanceDirection = performanceDirectionForNarration(narration, referencedCharacters.length > 0);
          const visual = String(item.visual || visualForNarration(narration, index, referencedCharacters[0]?.name || "主要人物"));
          const shotType = String(item.shotType || plan.shotType);
          const shot: Shot = {
            id: `shot-${String(index + 1).padStart(2, "0")}`, narration, duration, start: cursor, end: cursor + duration, visual,
            shotType, camera: String(item.camera || plan.camera),
            scene: creationMode === "short_drama" ? returnedScene : undefined,
            speaker: creationMode === "short_drama" ? String(item.speaker || dramaMetadata.speaker || "").trim() : undefined,
            dialogue: creationMode === "short_drama" ? String(item.dialogue || dramaMetadata.dialogue || "").trim() : undefined,
            extras: creationMode === "short_drama" ? String(item.extras || dramaMetadata.extras || "").trim() : undefined,
            imagePrompt: `景别：${shotType}。${String(item.imagePrompt || visual)}。人物表情与情境表演：${performanceDirection}。${effectiveStyle}，${ratio}${characterAnchor}，画面无文字、无水印`,
            videoPrompt: `景别：${shotType}。${String(item.videoPrompt || item.camera || cameras[index % cameras.length])}，${performanceDirection}${characterAnchor}，避免面部变形与主体漂移`,
            approved: false, imageState: "idle", videoState: "idle", variant: index % 6,
            characterIds: referencedCharacters.map((character) => character.id),
          };
          cursor += duration;
          return shot;
        });
        if (!validateCinematicCoverage(script, nextShots.map((shot) => shot.narration))) throw new Error("分镜模型没有逐字完整覆盖解说文稿，请点击重新生成；本次结果未写入项目。");
        nextShots = nextShots.map((shot, index, items) => {
          if (!index || shot.shotType !== items[index - 1].shotType) return shot;
          const plan = cinematicShotPlan(index);
          const revisedShot = { ...shot, shotType: plan.shotType, camera: shot.camera || plan.camera };
          return { ...revisedShot, ...syncShotCharacters(revisedShot, characters, effectiveStyle, ratio) };
        });
      } else {
        await wait(700);
        nextShots = buildShots(script, { style: effectiveStyle, ratio, pace, characters, creationMode });
      }
      setShots(nextShots);
      setActiveStep(3);
      finishGenerationProgress(progressId, `已生成 ${nextShots.length} 个节奏化电影分镜`);
      setToast(appSettings.mode === "live" ? "AI 分镜草案已生成，已进入分镜页" : "演示分镜草案已生成，已进入分镜页");
    } catch (error) {
      const message = error instanceof Error ? error.message : "分镜生成失败，请检查 API 设置";
      failGenerationProgress(progressId, message);
      setToast(message);
    } finally { setBusy(false); }
  }

  function updateShot(id: string, changes: Partial<Shot>) {
    setShots((items) => items.map((shot) => shot.id === id ? { ...shot, ...changes } : shot));
  }

  function updateShotType(shot: Shot, shotType: string) {
    if (!shotType || shotType === shot.shotType) return;
    if (!allowPaidInputChange("visual-change", shot.id)) return;
    const hadGeneratedAsset = Boolean(shot.imageUrl || shot.videoUrl || shot.imageState === "ready" || shot.videoState === "ready");
    if (hadGeneratedAsset && !window.confirm(`修改景别会让镜头 ${shot.id.replace("shot-", "")} 的现有图片和视频失效，需要重新生成。是否继续？`)) return;
    const nextShot: Shot = {
      ...shot,
      shotType,
      approved: false,
      imageState: "idle",
      videoState: "idle",
      imageUrl: "",
      videoUrl: "",
      videoTaskId: undefined,
      videoTaskProvider: undefined,
      videoSubmissionRisk: false,
      error: "",
    };
    updateShot(shot.id, { ...nextShot, ...syncShotCharacters(nextShot, activeCharacters, effectiveStyle, ratio) });
    setToast(`镜头 ${shot.id.replace("shot-", "")} 已改为${shotType}，图片和视频提示词已同步更新`);
  }

  function openManualShotSplit(shot: Shot) {
    const suggested = suggestShotSplit(shot.narration);
    setShotSplitDraft({ shotId: shot.id, first: suggested.first, second: suggested.second, error: "" });
  }

  async function confirmManualShotSplit() {
    if (!shotSplitDraft) return;
    const base = shots.find((shot) => shot.id === shotSplitDraft.shotId);
    if (!base) { setShotSplitDraft(null); return; }
    const firstNarration = shotSplitDraft.first.trim();
    const secondNarration = shotSplitDraft.second.trim();
    if (!firstNarration || !secondNarration) {
      setShotSplitDraft({ ...shotSplitDraft, error: "两个镜头都需要分配文案。" });
      return;
    }
    if (!splitTextMatchesSource(base.narration, firstNarration, secondNarration)) {
      setShotSplitDraft({ ...shotSplitDraft, error: "这里只能重新分配原镜头文案，不能增删文字；需要改文案时请先返回文稿页。" });
      return;
    }
    if (!await ensurePaidTasksAllow("visual-change", base.id)) return;
    const hasGeneratedMedia = Boolean(base.imageUrl || base.videoUrl || base.imageState === "ready" || base.videoState === "ready");
    if (hasGeneratedMedia && !window.confirm("拆分会让原镜头已生成的图片和视频失效，并创建两个待确认的新镜头。是否继续？")) return;

    const baseIndex = shots.findIndex((shot) => shot.id === base.id);
    const [firstDuration, secondDuration] = allocateSplitDurations(base.duration, firstNarration, secondNarration);
    const selectedCharacters = activeCharacters.filter((character) => base.characterIds?.includes(character.id));
    const buildPart = (narration: string, part: 0 | 1, duration: number): Shot => {
      const plan = cinematicShotPlan(baseIndex + part);
      const referenced = base.characterSelectionMode === "manual" ? selectedCharacters : charactersForNarration(narration, activeCharacters);
      const characterNameForVisual = referenced[0]?.name ?? activeCharacters[0]?.name ?? "主要人物";
      const visual = creationMode === "short_drama"
        ? `${base.visual}。${part === 0 ? "前一镜头聚焦动作的开始与动机" : "后一镜头承接动作结果与人物反应"}`
        : visualForNarration(narration, baseIndex + part, characterNameForVisual);
      const splitShot: Shot = {
        ...base,
        id: `shot-manual-${Date.now()}-${part + 1}`,
        narration,
        duration,
        start: 0,
        end: duration,
        visual,
        shotType: part === 0 ? base.shotType : plan.shotType === base.shotType ? cinematicShotPlan(baseIndex + part + 1).shotType : plan.shotType,
        camera: part === 0 ? base.camera : plan.camera,
        dialogue: base.dialogue && narration.includes(base.dialogue) ? base.dialogue : part === 0 && base.dialogue && !secondNarration.includes(base.dialogue) ? base.dialogue : undefined,
        approved: false,
        imageState: "idle",
        videoState: "idle",
        imageUrl: "",
        videoUrl: "",
        videoTaskId: undefined,
        videoTaskProvider: undefined,
        videoSubmissionRisk: false,
        error: "",
        variant: (base.variant + part) % 6,
        characterIds: referenced.map((character) => character.id),
      };
      return { ...splitShot, ...syncShotCharacters(splitShot, activeCharacters, effectiveStyle, ratio) };
    };
    const firstShot = buildPart(firstNarration, 0, firstDuration);
    const secondShot = buildPart(secondNarration, 1, secondDuration);
    setShots((items) => reflowShotTimeline(items.flatMap((shot) => shot.id === base.id ? [firstShot, secondShot] : [shot])) as Shot[]);
    setShotSplitDraft(null);
    setToast("已拆成两个镜头并自动重排时间；请分别检查景别、构图和提示词后确认");
  }

  function openShotCharacterLibrary(shot: Shot) {
    setShotCharacterLibraryDraft({ shotId: shot.id, selectedIds: [...(shot.characterIds || [])], error: "" });
  }

  function confirmShotCharacterLibrary() {
    if (!shotCharacterLibraryDraft) return;
    const target = shots.find((shot) => shot.id === shotCharacterLibraryDraft.shotId);
    if (!target) { setShotCharacterLibraryDraft(null); return; }
    if (!allowPaidInputChange("visual-change", target.id)) return;
    const selectedIds = shotCharacterLibraryDraft.selectedIds.filter((id) => activeCharacters.some((character) => character.id === id));
    if (selectedIds.length > 4) { setShotCharacterLibraryDraft({ ...shotCharacterLibraryDraft, error: "单个镜头最多选择 4 个固定角色，确保每个身份母版都能实际提交给图片模型。" }); return; }
    setShots((items) => items.map((shot) => {
      if (shot.id !== target.id) return shot;
      const selected: Shot = { ...shot, characterSelectionMode: "manual", characterIds: selectedIds, approved: false, imageState: "idle", videoState: shot.videoTaskId ? shot.videoState : "idle", imageUrl: "", videoUrl: shot.videoTaskId ? shot.videoUrl : "", error: "" };
      return { ...selected, ...syncShotCharacters(selected, activeCharacters, effectiveStyle, ratio) };
    }));
    setShotCharacterLibraryDraft(null);
    setToast(selectedIds.length ? `已从角色库为当前镜头选择 ${selectedIds.length} 个角色` : "当前镜头已设为无固定角色出镜");
  }

  function setShotCharacterSelection(shot: Shot, characterId: string, selected: boolean) {
    if (!allowPaidInputChange("visual-change", shot.id)) return;
    const current = new Set(shot.characterIds || []);
    if (selected && !current.has(characterId) && current.size >= 4) { setToast("单个镜头最多选择 4 个固定角色；请先取消一个角色再添加"); return; }
    if (selected) current.add(characterId); else current.delete(characterId);
    const nextShot = { ...shot, characterSelectionMode: "manual" as const, characterIds: [...current], approved: false, imageState: "idle" as AssetState, imageUrl: "", videoState: shot.videoTaskId ? shot.videoState : "idle" as AssetState, videoUrl: shot.videoTaskId ? shot.videoUrl : "" };
    updateShot(shot.id, { ...nextShot, ...syncShotCharacters(nextShot, activeCharacters, effectiveStyle, ratio) });
    setToast("已按你的选择更新本镜头出镜角色；请重新确认镜头");
  }

  function restoreAutomaticShotCharacters(shot: Shot) {
    if (!allowPaidInputChange("visual-change", shot.id)) return;
    const nextShot = { ...shot, characterSelectionMode: "auto" as const, approved: false, imageState: "idle" as AssetState, imageUrl: "", videoState: shot.videoTaskId ? shot.videoState : "idle" as AssetState, videoUrl: shot.videoTaskId ? shot.videoUrl : "" };
    updateShot(shot.id, { ...nextShot, ...syncShotCharacters(nextShot, activeCharacters, effectiveStyle, ratio) });
    setToast("本镜头已恢复按文稿自动识别角色");
  }

  function persistProjectIdentityBeforePaidSubmit() {
    try {
      const saved = window.localStorage.getItem("mujing-project-v1");
      const project = saved ? JSON.parse(saved) : {};
      if (project.projectId !== projectId) window.localStorage.setItem("mujing-project-v1", JSON.stringify({ ...project, projectId }));
    } catch {
      throw new Error("无法在付费提交前持久化项目身份；为避免任务记录无法恢复，已阻止提交。");
    }
  }

  function boundCharactersForShot(shot: Shot) {
    return activeCharacters.filter((character) => character.masterImage && shot.characterIds?.includes(character.id));
  }

  function referencedCharactersForShot(shot: Shot) {
    return activeCharacters.filter((character) => shot.characterIds?.includes(character.id));
  }

  function stageForShotCharacter(shot: Shot, character: CharacterAnchor) {
    return resolvedCharacterStage(shot.narration, character, shot.characterStageOverrides);
  }

  function missingCharacterReferencesForShots(targetShots: Shot[]) {
    return activeCharacters.filter((character) => !character.masterImage && targetShots.some((shot) => shot.characterIds?.includes(character.id)));
  }

  function updateShotVisual(shot: Shot, visual: string) {
    if (!allowPaidInputChange("visual-change", shot.id)) return;
    const nextShot = { ...shot, visual };
    updateShot(shot.id, { visual, ...syncShotCharacters(nextShot, activeCharacters, effectiveStyle, ratio) });
  }

  function updateShotDramaContext(shot: Shot, changes: Pick<Shot, "scene" | "speaker" | "extras">) {
    if (!allowPaidInputChange("visual-change", shot.id)) return;
    const selectedSpeaker = changes.speaker === undefined ? undefined : activeCharacters.find((character) => character.name === changes.speaker);
    const speakerOverride = selectedSpeaker ? { characterSelectionMode: "manual" as const, characterIds: [...new Set([...(shot.characterIds || []), selectedSpeaker.id])] } : {};
    const nextShot: Shot = { ...shot, ...changes, ...speakerOverride, approved: false, imageState: "idle", videoState: "idle", imageUrl: "", videoUrl: "", error: "" };
    updateShot(shot.id, { ...nextShot, ...syncShotCharacters(nextShot, activeCharacters, effectiveStyle, ratio) });
  }

  function updateShotCharacterStage(shot: Shot, character: CharacterAnchor, stage: CharacterStage) {
    if (!allowPaidInputChange("character-stage-change", shot.id)) return;
    if (!(character.stages || []).includes(stage)) return;
    const hadGeneratedAsset = Boolean(shot.imageUrl || shot.videoUrl || shot.imageState === "ready" || shot.videoState === "ready");
    if (hadGeneratedAsset && !window.confirm(`切换为${characterStageLabel(stage)}会让镜头 ${shot.id.replace("shot-", "")} 的现有图片和视频失效，需要重新生成。是否继续？`)) return;
    const nextShot: Shot = {
      ...shot,
      characterStageOverrides: { ...shot.characterStageOverrides, [character.id]: stage },
      imageState: "idle",
      videoState: "idle",
      imageUrl: "",
      videoUrl: "",
      videoTaskId: undefined,
      videoTaskProvider: undefined,
      videoSubmissionRisk: false,
      error: "",
    };
    updateShot(shot.id, { ...nextShot, ...syncShotCharacters(nextShot, activeCharacters, effectiveStyle, ratio) });
    setToast(`镜头 ${shot.id.replace("shot-", "")} 已手动切换为${characterStageLabel(stage)}，请重新生成该镜头图片`);
  }

  function updateShotImagePrompt(shot: Shot, imagePrompt: string) {
    if (!allowPaidInputChange("visual-change", shot.id)) return;
    updateShot(shot.id, {
      imagePrompt,
      imageState: "idle",
      videoState: "idle",
      imageUrl: "",
      videoUrl: "",
      videoTaskId: undefined,
      videoTaskProvider: undefined,
      videoSubmissionRisk: false,
      error: "",
    });
  }

  function updateShotVideoPrompt(shot: Shot, videoPrompt: string) {
    if (!allowPaidInputChange("visual-change", shot.id)) return;
    updateShot(shot.id, { videoPrompt, videoState: "idle", videoUrl: "", videoTaskId: undefined, videoTaskProvider: undefined, videoSubmissionRisk: false, error: "" });
  }

  function restoreShotImagePrompt(shot: Shot) {
    if (!allowPaidInputChange("visual-change", shot.id)) return;
    const nextShot = { ...shot, imageState: "idle" as AssetState, videoState: "idle" as AssetState, imageUrl: "", videoUrl: "", videoTaskId: undefined, videoTaskProvider: undefined, videoSubmissionRisk: false, error: "" };
    updateShot(shot.id, { ...nextShot, ...syncShotCharacters(nextShot, activeCharacters, effectiveStyle, ratio) });
    setToast(`镜头 ${shot.id.replace("shot-", "")} 已恢复 AI 情境与表情提示词`);
  }

  function restoreShotVideoPrompt(shot: Shot) {
    if (!allowPaidInputChange("visual-change", shot.id)) return;
    const videoPrompt = String(syncShotCharacters(shot, activeCharacters, effectiveStyle, ratio).videoPrompt || shot.videoPrompt);
    updateShotVideoPrompt(shot, videoPrompt);
    setToast(`镜头 ${shot.id.replace("shot-", "")} 已恢复完整的视频动态提示词`);
  }

  async function optimizeShotImagePrompt(shot: Shot, noticeConfirmed = false) {
    if (!allowPaidInputChange("visual-change", shot.id)) return;
    if (appSettings.mode === "live" && !noticeConfirmed) {
      requestGeneration({ title: `AI 优化镜头 ${shot.id.replace("shot-", "")} 提示词`, model: generationModel(providers.storyboard, "storyboard"), provider: providers.storyboard, itemCount: 1, uploads: "该镜头的文案、画面描述、当前提示词、角色年龄阶段、画面比例与全片风格" }, () => { void optimizeShotImagePrompt(shot, true); });
      return;
    }
    const progressId = beginGenerationProgress("AI 优化分镜提示词", 1, `正在理解镜头 ${shot.id.replace("shot-", "")} 的台词情绪与真实情境…`);
    setOptimizingPromptShotId(`${shot.id}:image`);
    try {
      let prompt: string;
      if (appSettings.mode === "live") {
        if (!window.mujingDesktop) throw new Error("AI 优化提示词仅在安装版中可使用真实模型。");
        const characters = referencedCharactersForShot(shot).map((character) => ({ name: character.name, description: character.description, stage: stageForShotCharacter(shot, character) }));
        prompt = (await window.mujingDesktop.optimizeImagePrompt({ provider: providers.storyboard, narration: shot.narration, visual: shot.visual, currentPrompt: shot.imagePrompt, style: effectiveStyle, ratio, characters })).prompt;
      } else {
        await wait(450);
        prompt = String(syncShotCharacters(shot, activeCharacters, effectiveStyle, ratio).imagePrompt || shot.imagePrompt);
      }
      updateShotImagePrompt(shot, prompt);
      finishGenerationProgress(progressId, `镜头 ${shot.id.replace("shot-", "")} 的表情、动作与电影画面提示词已优化`);
      setToast(`镜头 ${shot.id.replace("shot-", "")} 的 AI 提示词已优化，仍可继续手动修改`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "AI 优化提示词失败";
      failGenerationProgress(progressId, message);
      setToast(message);
    } finally {
      setOptimizingPromptShotId("");
    }
  }

  async function optimizeShotVideoPrompt(shot: Shot, noticeConfirmed = false) {
    if (!allowPaidInputChange("visual-change", shot.id)) return;
    if (appSettings.mode === "live" && !noticeConfirmed) {
      requestGeneration({ title: `AI 优化镜头 ${shot.id.replace("shot-", "")} 视频提示词`, model: generationModel(providers.storyboard, "storyboard"), provider: providers.storyboard, itemCount: 1, uploads: "该镜头的文案、画面描述、当前视频提示词、人物年龄、镜头时长、景别、运镜、比例与全片风格" }, () => { void optimizeShotVideoPrompt(shot, true); });
      return;
    }
    const progressId = beginGenerationProgress("AI 优化视频提示词", 1, `正在设计镜头 ${shot.id.replace("shot-", "")} 的连续动作、表演和摄影机运动…`);
    setOptimizingPromptShotId(`${shot.id}:video`);
    try {
      let prompt: string;
      if (appSettings.mode === "live") {
        if (!window.mujingDesktop) throw new Error("AI 优化视频提示词仅在安装版中可使用真实模型。");
        const characters = referencedCharactersForShot(shot).map((character) => ({ name: character.name, description: character.description, stage: stageForShotCharacter(shot, character), hasMasterImage: Boolean(character.masterImage) }));
        prompt = (await window.mujingDesktop.optimizeVideoPrompt({ provider: providers.storyboard, videoProvider: providers.video, videoModel: activeVideoPromptModel(), narration: shot.narration, visual: shot.visual, currentPrompt: shot.videoPrompt, style: effectiveStyle, ratio, duration: shot.duration, shotType: shot.shotType, camera: shot.camera, imageRole: videoImageRole, faceVisibility: referenceFaceVisibility(`${shot.visual} ${shot.videoPrompt}`), characters })).prompt;
      } else {
        await wait(450);
        prompt = String(syncShotCharacters(shot, activeCharacters, effectiveStyle, ratio).videoPrompt || shot.videoPrompt);
      }
      updateShotVideoPrompt(shot, prompt);
      finishGenerationProgress(progressId, `镜头 ${shot.id.replace("shot-", "")} 的连续动作、表演与摄影机运动已优化`);
      setToast(`镜头 ${shot.id.replace("shot-", "")} 的视频提示词已优化，仍可继续手动修改`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "AI 优化视频提示词失败";
      failGenerationProgress(progressId, message);
      setToast(message);
    } finally {
      setOptimizingPromptShotId("");
    }
  }

  function updateRatio(nextRatio: string) {
    if (!allowPaidInputChange("ratio-change")) return;
    setRatio(nextRatio);
    setShots((items) => items.map((shot) => ({ ...shot, ...syncShotCharacters(shot, activeCharacters, effectiveStyle, nextRatio) })));
  }

  function updateCharacterProfile(change: () => void) {
    if (!allowPaidInputChange("character-profile-change")) return;
    change();
  }

  function importCustomStyleReference(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    if (!new Set(["image/png", "image/jpeg", "image/webp"]).has(file.type)) {
      setToast("风格参考图仅支持 PNG、JPEG 或 WebP");
      return;
    }
    if (file.size > 12 * 1024 * 1024) {
      setToast("风格参考图不能超过 12 MB");
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const dataUrl = String(reader.result ?? "");
        const saved = window.mujingDesktop && dataUrl ? await window.mujingDesktop.saveDataUrl({ dataUrl, prefix: "style-reference" }) : { url: dataUrl };
        setCustomStyleReferenceImage(saved.url);
        setToast("风格参考图已导入；点击“AI 分析参考图”提取视觉语言");
      } catch (error) {
        setToast(error instanceof Error ? error.message : "风格参考图保存失败");
      }
    };
    reader.onerror = () => setToast("无法读取这张风格参考图");
    reader.readAsDataURL(file);
  }

  async function analyzeCustomStyleReference(noticeConfirmed = false) {
    if (!customStyleReferenceImage) { setToast("请先导入一张风格参考图"); return; }
    if (busy || styleAnalysisBusy) { setToast("当前还有生成任务，请稍候再分析风格"); return; }
    if (appSettings.mode === "live" && !noticeConfirmed) {
      requestGeneration({
        title: "分析自定义风格参考图",
        model: generationModel(providers.storyboard, "storyboard"),
        provider: providers.storyboard,
        itemCount: 1,
        uploads: "你选择的风格参考图、现有自定义提示词与画面比例；只提取视觉风格，不识别或复用人物身份",
      }, () => void analyzeCustomStyleReference(true));
      return;
    }
    const progressId = beginGenerationProgress("AI 分析自定义风格", 1, "正在读取参考图的色调、光线、材质与镜头语言…");
    setStyleAnalysisBusy(true);
    try {
      let prompt = "低饱和自然色彩，柔和侧逆光与克制反差，细腻材质纹理和轻微胶片颗粒；简洁分层构图，中等景深与自然焦段感，背景层次清晰但不抢主体；镜头运动缓慢、稳定、幅度克制，整体安静、真实并富有呼吸感。保持全片视觉语言与光色一致，人物身份由角色母版另行控制，无文字、无水印。";
      if (appSettings.mode === "live") {
        if (!window.mujingDesktop) throw new Error("真实 AI 分析需要在幕境桌面版中使用");
        updateGenerationProgress(progressId, { detail: "正在调用语言模型分析参考图…", current: 0 });
        prompt = (await window.mujingDesktop.analyzeStyleReference({ provider: providers.storyboard, imageUrl: customStyleReferenceImage, existingPrompt: customStyle, ratio })).prompt;
      } else {
        await wait(700);
      }
      if (!prompt.trim()) throw new Error("AI 没有返回可用的风格提示词");
      setCustomStyle(prompt.trim());
      finishGenerationProgress(progressId, "视觉风格已写入自定义提示词，请检查后再应用");
      setToast("AI 已完成风格分析；你可以继续修改，确认后点击“应用自定义风格”");
    } catch (error) {
      const message = error instanceof Error ? error.message : "AI 分析风格参考图失败";
      failGenerationProgress(progressId, message);
      setToast(message);
    } finally {
      setStyleAnalysisBusy(false);
    }
  }

  async function applyGlobalStyle(nextStyle: string, customPrompt = customStyle) {
    const nextDefinition = videoStyles.find((option) => option.name === nextStyle) ?? videoStyles[0];
    const nextPrompt = nextStyle === "自定义风格" && customPrompt.trim() ? customPrompt.trim() : nextDefinition.prompt;
    if (!await ensurePaidTasksAllow("style-change")) return;
    if (nextStyle === "自定义风格" && !customPrompt.trim()) {
      setStyle("自定义风格");
      setStyleOpen(true);
      setToast("请先输入自定义风格描述");
      return;
    }
    if (shots.some((shot) => shot.imageState === "ready" || shot.videoState === "ready") && !window.confirm("更换全片风格会刷新全部提示词，并将已生成的镜头标记为需要重新生成。继续吗？")) return;
    setStyle(nextStyle);
    setShots((items) => items.map((shot) => {
      const preservePaidVideo = Boolean(shot.videoTaskId);
      return { ...shot, ...syncShotCharacters(shot, activeCharacters, nextPrompt, ratio), imageState: "idle", imageUrl: "", videoState: preservePaidVideo ? shot.videoState : "idle", videoUrl: preservePaidVideo ? shot.videoUrl : "" };
    }));
    setStyleOpen(false);
    setToast(`全片风格已切换为${nextStyle}${shots.length ? "，提示词已统一刷新" : ""}`);
  }

  async function generateAssets(kind: "image" | "video", singleId?: string, noticeConfirmed = false) {
    if (!validateCharactersForGeneration()) return;
    const targets = shots.filter((shot) => {
      if (!shot.approved || (singleId && shot.id !== singleId)) return false;
      const state = kind === "image" ? shot.imageState : shot.videoState;
      if (["submitting", "downloading"].includes(state)) return false;
      if (singleId) return state !== "generating" || (kind === "video" && Boolean(shot.videoTaskId));
      return state !== "ready" && (state !== "generating" || (kind === "video" && Boolean(shot.videoTaskId)));
    });
    if (!targets.length) { setToast("请先确认需要生成的分镜"); return; }
    const referenceRequiredTargets = kind === "video" ? targets.filter((shot) => !shot.videoTaskId) : targets;
    const missingReferences = missingCharacterReferencesForShots(referenceRequiredTargets);
    if (missingReferences.length) {
      const missingNames = missingReferences.map((character) => `“${character.name}”`).join("、");
      const progressId = beginGenerationProgress(kind === "image" ? "生成分镜图片" : "生成视频镜头", targets.length, `正在检查 ${targets.length} 个镜头的角色一致性…`);
      failGenerationProgress(progressId, `缺少${missingNames}的身份母版，已暂停生成并打开角色页`);
      setActiveStep(2);
      setToast(`已暂停生成：请先为${missingNames}生成或导入角色母版，避免人物在不同镜头中变脸`);
      return;
    }
    if (kind === "image" && !await ensurePaidTasksAllow("first-frame-change", singleId)) return;
    if (kind === "video" && targets.some((shot) => shot.imageState !== "ready")) {
      setToast("请先为镜头生成分镜图片");
      return;
    }
    if (appSettings.mode === "live" && !noticeConfirmed) {
      const provider = kind === "image" ? providers.image : providers.video;
      requestGeneration({ title: kind === "image" ? "生成分镜图片" : "生成视频镜头", model: generationModel(provider, kind), provider, itemCount: targets.length, uploads: kind === "image" ? `本次 ${targets.length} 个镜头的提示词、画面比例，以及各镜头已绑定的角色参考图` : `本次 ${targets.length} 个镜头的提示词、画面比例、时长，以及各镜头${videoImageRole === "reference_image" ? "参考图片（不锁定首帧）" : "严格首帧图片"}` }, () => { void generateAssets(kind, singleId, true); });
      return;
    }
    const progressId = beginGenerationProgress(kind === "image" ? "生成分镜图片" : "生成视频镜头", targets.length, `正在准备第 1 / ${targets.length} 个镜头…`);
    generationCancelRequested.current = false;
    setBusy(true);
    for (const [targetIndex, target] of targets.entries()) {
      if (generationCancelRequested.current) {
        for (const queued of targets.slice(targetIndex)) updateShot(queued.id, kind === "video" ? stopShotLocally(queued) : { imageState: "canceled" });
        break;
      }
      stoppedShotIds.current.delete(target.id);
      updateGenerationProgress(progressId, { current: targetIndex, detail: `正在处理镜头 ${target.id.replace("shot-", "")}（第 ${targetIndex + 1} / ${targets.length} 个）` });
      const stateKey = kind === "image" ? "imageState" : "videoState";
      const taskAction = kind === "video" ? videoTaskAction(target) : { kind: "submit" };
      if (taskAction.kind === "blocked") {
        failGenerationProgress(progressId, taskAction.reason);
        setToast(taskAction.reason);
        setBusy(false);
        return;
      }
      updateShot(target.id, { [stateKey]: taskAction.kind === "resume" ? "generating" : "submitting", error: "" } as Partial<Shot>);
      try {
        if (appSettings.mode === "live") {
          if (!window.mujingDesktop) throw new Error("真实生成仅在安装版中可用。");
          if (kind === "image") {
            const references = boundCharactersForShot(target).map((character) => character.masterImage).filter(Boolean);
            const result = await window.mujingDesktop.createImage({ shotId: target.id, provider: providers.image, prompt: target.imagePrompt, ratio, references, enforceAspect: true });
            updateShot(target.id, { imageState: "ready", imageUrl: result.url });
          } else {
            let jobId = taskAction.kind === "resume" ? taskAction.jobId : undefined;
            let taskProvider = taskAction.kind === "resume" ? taskAction.provider : undefined;
            if (!jobId) {
              if (providers.video !== "本地 ComfyUI") persistProjectIdentityBeforePaidSubmit();
              const identityGuard = videoIdentityGuard(target, boundCharactersForShot(target));
              const submitted = await window.mujingDesktop.submitVideoTask({ projectId, shotId: target.id, provider: providers.video, prompt: `${target.visual}。${target.videoPrompt}${identityGuard ? `。${identityGuard}` : ""}`, ratio, duration: target.duration, resolution: "720p", imageRole: videoImageRole, generateAudio: false, imageUrl: target.imageUrl, enforceAspect: true });
              jobId = submitted.jobId;
              taskProvider = String(submitted.provider || (providers.video === "本地 ComfyUI" ? "本地 ComfyUI" : "")).trim();
              if (!taskProvider) throw new Error("视频任务返回了任务 ID，但缺少原服务商；已停止轮询以避免错误请求。");
              updateShot(target.id, { videoState: "generating", videoTaskId: jobId, videoTaskProvider: taskProvider, videoSubmissionRisk: false });
            }
            if (!taskProvider) throw new Error("旧项目缺少原服务商，无法安全轮询；未向当前服务商发送请求。");
            const pollingPolicy = videoPollingPolicy(taskProvider);
            const polling = await pollPaidTaskUntilSettled({
              maxAttempts: pollingPolicy.maxAttempts,
              shouldStop: () => generationCancelRequested.current || stoppedShotIds.current.has(target.id),
              poll: () => window.mujingDesktop!.pollVideoTask({ projectId, shotId: target.id, provider: taskProvider, jobId }),
              wait: () => wait(pollingPolicy.intervalMs),
            });
            if (polling.kind === "stopped") {
              if (taskProvider === "本地 ComfyUI") {
                await window.mujingDesktop.cancelVideoTask({ provider: taskProvider, jobId });
                updateShot(target.id, { videoState: "canceled", videoTaskId: undefined, videoTaskProvider: undefined, videoSubmissionRisk: false, error: "已中断本地 ComfyUI 任务。" });
              } else updateShot(target.id, stopShotLocally({ ...target, videoTaskId: jobId, videoTaskProvider: taskProvider }));
              if (generationCancelRequested.current) {
                for (const queued of targets.slice(targetIndex + 1)) updateShot(queued.id, stopShotLocally(queued));
                break;
              }
              continue;
            }
            if (polling.kind === "timed-out") throw new Error("视频任务仍在服务商队列中；任务 ID 已保存，重试只会继续轮询，不会再次提交。");
            const result = polling.result;
            if (result.status === "canceled") { updateShot(target.id, { videoState: "canceled", videoTaskId: undefined, videoTaskProvider: undefined, error: "服务商已取消此任务，编辑锁已解除。" }); continue; }
            if (!["succeeded", "completed"].includes(result.status) || !result.url) {
              updateShot(target.id, { videoTaskId: undefined, videoTaskProvider: undefined });
              throw new Error(result.error || "视频任务失败；服务商已返回终态，编辑锁已解除。");
            }
            updateShot(target.id, { videoState: "ready", videoUrl: result.url, videoTaskId: jobId });
          }
        } else {
          await wait(360);
          if (kind === "image") {
            const dataUrl = createDemoFrame(target, ratio);
            const saved = window.mujingDesktop && dataUrl ? await window.mujingDesktop.saveDataUrl({ dataUrl, prefix: target.id }) : { url: dataUrl };
            updateShot(target.id, { imageState: "ready", imageUrl: saved.url });
          } else {
            updateShot(target.id, { videoState: "ready", videoUrl: "" });
          }
        }
        updateGenerationProgress(progressId, { current: targetIndex + 1, detail: `镜头 ${target.id.replace("shot-", "")} 已完成，准备下一个镜头…` });
      } catch (error) {
        const message = error instanceof Error ? error.message : "生成失败";
        updateShot(target.id, { [stateKey]: "error", ...(kind === "video" ? { videoSubmissionRisk: providers.video === "本地 ComfyUI" ? false : paidSubmissionRiskFromError(message) } : {}), error: message } as Partial<Shot>);
        failGenerationProgress(progressId, `镜头 ${target.id.replace("shot-", "")}：${message}`);
        setToast(`镜头 ${target.id.replace("shot-", "")}：${error instanceof Error ? error.message : "生成失败"}`);
        setBusy(false);
        return;
      }
    }
    setBusy(false);
    if (generationCancelRequested.current) cancelGenerationProgress(progressId, "生成队列已停止，尚未提交的镜头已取消");
    else finishGenerationProgress(progressId, kind === "image" ? `${targets.length} 个分镜图片已全部生成` : appSettings.mode === "live" ? `${targets.length} 个视频镜头已全部生成` : `${targets.length} 个演示动效已就绪`);
    setToast(generationCancelRequested.current ? "生成队列已停止，尚未提交镜头已取消" : kind === "image" ? "分镜图片已生成" : appSettings.mode === "live" ? "视频镜头已生成" : "演示动效已就绪，导出时会生成视频");
  }

  async function explicitlyResubmitVideoTask(shot: Shot) {
    if (!window.mujingDesktop) { setToast("真实生成仅在安装版中可用。"); return; }
    const progressId = beginGenerationProgress("重新生成视频镜头", 1, `正在为镜头 ${shot.id.replace("shot-", "")}申请重新提交…`);
    stoppedShotIds.current.delete(shot.id);
    generationCancelRequested.current = false;
    setBusy(true);
    updateShot(shot.id, { videoState: "submitting", error: "正在按明确重提路径原子更新付费任务记录…" });
    let replacementJobId: string | undefined;
    let replacementProvider: string | undefined;
    let replacementTerminal = false;
    try {
      persistProjectIdentityBeforePaidSubmit();
      const paidRequest = {
        projectId,
        shotId: shot.id,
        provider: providers.video,
        prompt: `${shot.visual}。${shot.videoPrompt}${videoIdentityGuard(shot, boundCharactersForShot(shot)) ? `。${videoIdentityGuard(shot, boundCharactersForShot(shot))}` : ""}`,
        ratio,
        duration: shot.duration,
        resolution: "720p",
        imageRole: videoImageRole,
        generateAudio: false,
        imageUrl: shot.imageUrl,
        enforceAspect: true,
      };
      const authorization = await window.mujingDesktop.requestVideoResubmitAuthorization(paidRequest);
      if (!authorization.authorized || !authorization.token) {
        updateShot(shot.id, { videoState: "error", error: "已取消付费重提；未发送新增请求。" });
        cancelGenerationProgress(progressId, "已取消付费重提，未发送新增请求");
        setToast("已取消付费重提，未产生新增请求");
        return;
      }
      const submitted = await window.mujingDesktop.resubmitVideoTask({ ...paidRequest, authorizationToken: authorization.token });
      const jobId = submitted.jobId;
      const taskProvider = String(submitted.provider || "").trim();
      if (!taskProvider) throw new Error("新付费任务缺少原服务商，已停止轮询以避免错误请求。");
      replacementJobId = jobId;
      replacementProvider = taskProvider;
      updateShot(shot.id, { videoState: "generating", videoTaskId: jobId, videoTaskProvider: taskProvider, videoSubmissionRisk: false, error: "" });
      const polling = await pollPaidTaskUntilSettled({
        maxAttempts: 120,
        shouldStop: () => generationCancelRequested.current || stoppedShotIds.current.has(shot.id),
        poll: () => window.mujingDesktop!.pollVideoTask({ projectId, shotId: shot.id, provider: taskProvider, jobId }),
        wait: () => wait(10000),
      });
      if (polling.kind === "stopped") {
        updateShot(shot.id, stopShotLocally({ ...shot, videoTaskId: jobId, videoTaskProvider: taskProvider }));
        cancelGenerationProgress(progressId, "已停止本地轮询；远端任务可能仍在运行");
        setToast("仅停止本地轮询；远端新任务可能继续并计费，任务 ID 已保留");
        return;
      }
      if (polling.kind === "timed-out") throw new Error("新任务仍在服务商队列中；任务 ID 已保存，后续只会继续轮询。");
      const result = polling.result;
      if (!["succeeded", "completed"].includes(result.status) || !result.url) {
        replacementTerminal = true;
        replacementJobId = undefined;
        replacementProvider = undefined;
        updateShot(shot.id, { videoTaskId: undefined, videoTaskProvider: undefined });
        throw new Error(result.error || "新视频任务失败；服务商已返回终态，编辑锁已解除。");
      }
      updateShot(shot.id, { videoState: "ready", videoUrl: result.url, videoTaskId: jobId, videoTaskProvider: taskProvider, error: "" });
      finishGenerationProgress(progressId, `镜头 ${shot.id.replace("shot-", "")} 的视频已生成`);
      setToast("明确重新提交的视频任务已完成");
    } catch (error) {
      const message = error instanceof Error ? error.message : "明确重新提交失败";
      updateShot(shot.id, { videoState: "error", videoTaskId: replacementTerminal ? undefined : replacementJobId || shot.videoTaskId, videoTaskProvider: replacementTerminal ? undefined : replacementProvider || shot.videoTaskProvider, videoSubmissionRisk: replacementTerminal ? false : Boolean(shot.videoSubmissionRisk || (!replacementJobId && paidSubmissionRiskFromError(message))), error: message });
      failGenerationProgress(progressId, message);
      setToast(error instanceof Error ? error.message : "明确重新提交失败");
    } finally { setBusy(false); }
  }

  function restartVideoTask(shot: Shot) {
    if (!shot.videoTaskId && !shot.videoSubmissionRisk) { void generateAssets("video", shot.id); return; }
    void explicitlyResubmitVideoTask(shot);
  }

  function importScript(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const invalidated = updateScript(String(reader.result ?? ""), `已导入 ${file.name}；原配音已失效，请重新生成配音`);
      if (invalidated) return;
      setToast(`已导入 ${file.name}`);
    };
    reader.readAsText(file);
  }

  async function importProjectPackage(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) { setToast("项目制作包超过 25 MB，已停止导入"); return; }
    try {
      const project = parseProjectPackageText(await file.text());
      const summary = importedPackageSummary(project);
      if (!await ensurePaidTasksAllow("storyboard-clear")) return;
      if (!window.confirm(`导入“${summary.name}”会替换当前项目。\n\n将恢复 ${summary.shots} 个镜头${summary.hasVoice ? "、配音" : ""}${summary.hasMusic ? "、背景音乐" : ""}；主进程中未完成的收费任务不会被删除。是否继续？`)) return;

      const validStates = new Set<AssetState>(["idle", "submitting", "generating", "downloading", "ready", "error", "canceled"]);
      let missingMedia = 0;
      let cursor = 0;
      const importedShots: Shot[] = project.shots.map((raw: Partial<Shot>, index: number) => {
        const duration = Math.round(Math.max(0.1, Math.min(3_600, Number(raw.duration) || 3)) * 1000) / 1000;
        const imageUrl = restoreLocalMediaUrl(raw.imageUrl);
        const videoUrl = restoreLocalMediaUrl(raw.videoUrl);
        let imageState: AssetState = validStates.has(raw.imageState as AssetState) ? raw.imageState as AssetState : "idle";
        let videoState: AssetState = validStates.has(raw.videoState as AssetState) ? raw.videoState as AssetState : "idle";
        let error = String(raw.error || "");
        if (imageState === "ready" && !imageUrl) { imageState = "error"; missingMedia += 1; error = "项目包中的镜头图片不在本机，请重新生成。"; }
        if (videoState === "ready" && !videoUrl) { videoState = "error"; missingMedia += 1; error = "项目包中的镜头视频不在本机，请重新生成。"; }
        if (["submitting", "generating", "downloading"].includes(imageState)) { imageState = "error"; error = "项目导入后无法恢复未完成的图片请求，请重新生成。"; }
        if (["submitting", "downloading"].includes(videoState) && raw.videoTaskId) videoState = "generating";
        else if (["submitting", "generating", "downloading"].includes(videoState) && !raw.videoTaskId) { videoState = "error"; error = "项目导入后缺少视频任务 ID，请重新生成。"; }
        const plan = cinematicShotPlan(index);
        const shot: Shot = {
          id: String(raw.id || `shot-${String(index + 1).padStart(2, "0")}`),
          narration: String(raw.narration || ""), duration, start: cursor, end: cursor + duration,
          visual: String(raw.visual || ""), shotType: String(raw.shotType || plan.shotType), camera: String(raw.camera || plan.camera),
          scene: raw.scene ? String(raw.scene).slice(0, 300) : undefined,
          speaker: raw.speaker ? String(raw.speaker).slice(0, 100) : undefined,
          dialogue: raw.dialogue ? String(raw.dialogue).slice(0, 2_000) : undefined,
          extras: raw.extras ? String(raw.extras).slice(0, 300) : undefined,
          imagePrompt: String(raw.imagePrompt || raw.visual || ""), videoPrompt: String(raw.videoPrompt || raw.camera || plan.camera),
          approved: Boolean(raw.approved), imageState, videoState, variant: Number.isInteger(raw.variant) ? Number(raw.variant) : index % 6,
          characterIds: Array.isArray(raw.characterIds) ? raw.characterIds.filter((id): id is CharacterKey => typeof id === "string" && /^(?:primary|secondary|extra-[a-z0-9-]{1,80})$/i.test(id)) : [],
          characterSelectionMode: raw.characterSelectionMode === "manual" ? "manual" : "auto",
          characterStageOverrides: raw.characterStageOverrides && typeof raw.characterStageOverrides === "object" ? Object.fromEntries(Object.entries(raw.characterStageOverrides).filter(([key, value]) => /^(?:primary|secondary|extra-[a-z0-9-]{1,80})$/i.test(key) && (value === "child" || value === "adult" || value === "elder"))) as Partial<Record<CharacterKey, CharacterStage>> : undefined,
          imageUrl, videoUrl, videoTaskId: raw.videoTaskId ? String(raw.videoTaskId) : undefined,
          videoTaskProvider: raw.videoTaskProvider ? String(raw.videoTaskProvider) : undefined,
          videoSubmissionRisk: Boolean(raw.videoSubmissionRisk), error,
        };
        cursor += duration;
        return shot;
      });

      const characters = Array.isArray(project.characters) ? project.characters : [];
      const primary = characters.find((character: CharacterAnchor) => character?.id === "primary");
      const secondary = characters.find((character: CharacterAnchor) => character?.id === "secondary");
      const packagedManualCharacters = Array.isArray(project.manualCharacters) ? project.manualCharacters : characters.filter((character: CharacterAnchor) => typeof character?.id === "string" && character.id.startsWith("extra-"));
      const restoredManualCharacters: ManualCharacter[] = packagedManualCharacters.slice(0, 8).map((character: Partial<ManualCharacter & CharacterAnchor>, index: number) => ({
        id: /^extra-[a-z0-9-]{1,80}$/i.test(String(character.id || "")) ? String(character.id) : `extra-imported-${index + 1}`,
        name: String(character.name || `角色${index + 3}`),
        description: String(character.description || "固定角色，在所有相关镜头中保持外貌、服装与体型一致"),
        enabled: character.enabled !== false,
        referenceImage: restoreLocalMediaUrl(character.referenceImage || character.masterImage),
        generatedImage: restoreLocalMediaUrl(character.generatedImage),
      }));
      const nextScript = String(project.script || "");
      const inferredPrimary = inferPrimaryCharacterProfile(nextScript);
      const primaryMaster = restoreLocalMediaUrl(primary?.masterImage || project.primaryGeneratedImage || project.referenceImage);
      const secondaryMaster = restoreLocalMediaUrl(secondary?.masterImage || project.secondaryGeneratedImage || project.secondaryReferenceImage);
      const trustedVoice = Boolean(project.voiceUrl && project.voiceProvenance?.mediaId && project.voiceProvenance?.scriptSha256);
      const restoredVoiceUrl = trustedVoice ? restoreLocalMediaUrl(project.voiceUrl) : "";
      const restoredMusicUrl = restoreLocalMediaUrl(project.musicUrl);
      if (project.voiceUrl && !restoredVoiceUrl) missingMedia += 1;
      if (project.musicUrl && !restoredMusicUrl) missingMedia += 1;

      setProjectId(String(project.projectId || createProjectId()));
      setProjectName(String(project.projectName || "导入的项目").slice(0, 80));
      setProjectNameDraft(String(project.projectName || "导入的项目").slice(0, 80));
      setCreationMode(project.creationMode === "short_drama" ? "short_drama" : "narration");
      setScript(nextScript);
      setRatio(project.ratio === "9:16" ? "9:16" : "16:9");
      setStyle(videoStyles.some((option) => option.name === project.style) ? project.style : "电影写实");
      setCustomStyle(String(project.customStyle || ""));
      setCustomStyleReferenceImage(restoreLocalMediaUrl(project.customStyleReferenceImage));
      setPace(["舒缓", "自然", "紧凑"].includes(project.pace) ? project.pace : "自然");
      setVideoImageRole(project.videoImageRole === "first_frame" ? "first_frame" : "reference_image");
      setProviders(normalizeProviders(project.providers));
      setShots(importedShots);
      setCharacterEnabled(primary ? true : project.characterEnabled ?? true);
      setCharacterName(String(primary?.name || project.characterName || inferredPrimary.name || "主要人物"));
      setCharacterDescription(String(primary?.description || project.characterDescription || ""));
      setReferenceImage(primaryMaster);
      setPrimaryGeneratedImage("");
      setSecondaryCharacterEnabled(secondary ? true : project.secondaryCharacterEnabled ?? false);
      setSecondaryCharacterName(String(secondary?.name || project.secondaryCharacterName || "第二角色"));
      setSecondaryCharacterDescription(String(secondary?.description || project.secondaryCharacterDescription || ""));
      setSecondaryReferenceImage(secondaryMaster);
      setSecondaryGeneratedImage("");
      setManualCharacters(restoredManualCharacters);
      setVoiceUrl(restoredVoiceUrl);
      setVoiceProvenance(restoredVoiceUrl ? project.voiceProvenance : null);
      setVoiceId(String(project.voiceId || "marin"));
      setVoiceTimelineAligned(Boolean(restoredVoiceUrl && project.voiceTimelineAligned));
      setVoiceState(restoredVoiceUrl ? "ready" : "idle");
      setMusicUrl(restoredMusicUrl);
      setMusicName(restoredMusicUrl ? String(project.musicName || "背景音乐") : "");
      setMusicVolume(Math.max(0, Math.min(100, Number(project.musicVolume ?? 22))));
      setActiveStep(importedShots.length ? Math.max(1, Math.min(5, Number(project.activeStep) || 3)) : 1);
      setPlayhead(0); setPlaying(false); setUndoClearedScript(null); setUndoClearedStoryboard(null);
      setToast(missingMedia ? `已导入 ${file.name}；有 ${missingMedia} 项本地素材缺失，已标记为需要重新生成` : `已完整导入 ${file.name}`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "项目制作包导入失败");
    }
  }

  function importCharacter(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!allowPaidInputChange("character-profile-change")) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = String(reader.result ?? "");
      const saved = window.mujingDesktop && dataUrl ? await window.mujingDesktop.saveDataUrl({ dataUrl, prefix: "character-primary" }) : { url: dataUrl };
      setReferenceImage(saved.url);
      setPrimaryGeneratedImage("");
      const nextCharacters = activeCharacters.map((character) => character.id === "primary" ? { ...character, masterImage: saved.url } : character);
      setShots((items) => items.map((shot) => ({ ...shot, ...syncShotCharacters(shot, nextCharacters, effectiveStyle, ratio) })));
      setToast("主角参考图已导入并强制绑定到所有相关分镜");
    };
    reader.readAsDataURL(file);
  }

  function importSecondaryCharacter(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!allowPaidInputChange("character-profile-change")) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = String(reader.result ?? "");
      const saved = window.mujingDesktop && dataUrl ? await window.mujingDesktop.saveDataUrl({ dataUrl, prefix: "character-secondary" }) : { url: dataUrl };
      setSecondaryReferenceImage(saved.url);
      setSecondaryGeneratedImage("");
      const nextCharacters = activeCharacters.map((character) => character.id === "secondary" ? { ...character, masterImage: saved.url } : character);
      setShots((items) => items.map((shot) => ({ ...shot, ...syncShotCharacters(shot, nextCharacters, effectiveStyle, ratio) })));
      setToast("第二角色参考图已导入并绑定到相关分镜");
    };
    reader.readAsDataURL(file);
  }

  function anchorsForManualCharacters(items: ManualCharacter[]) {
    return items.filter((character) => character.enabled).map((character) => ({ id: character.id, name: character.name, description: character.description, masterImage: character.generatedImage || character.referenceImage || undefined, prompt: buildCharacterPrompt({ name: character.name, description: character.description, stages: ["adult"] }, effectiveStyle, Boolean(character.generatedImage || character.referenceImage)), aliases: [character.name], stages: ["adult" as CharacterStage], firstPerson: false }));
  }

  function commitManualCharacters(next: ManualCharacter[]) {
    setManualCharacters(next);
    const nextCharacters = [...activeCharacters.filter((character) => !character.id.startsWith("extra-")), ...anchorsForManualCharacters(next)];
    setShots((items) => items.map((shot) => ({ ...shot, ...syncShotCharacters(shot, nextCharacters, effectiveStyle, ratio) })));
  }

  function addManualCharacter() {
    if (!allowPaidInputChange("character-profile-change")) return;
    if (manualCharacters.length >= 8) { setToast("一个项目最多可以手动添加 8 个额外角色"); return; }
    const number = manualCharacters.length + 3;
    const id = `extra-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    commitManualCharacters([...manualCharacters, { id, name: `新角色${number}`, description: "故事中的固定角色；请填写面部、发型、服装、体型和标志性随身物品，并在所有相关镜头中保持一致", enabled: true, referenceImage: "", generatedImage: "" }]);
    setCharacterError("");
    setToast(`已添加第 ${number} 个角色，请填写可辨认的称呼与外观特征`);
  }

  function updateManualCharacter(id: string, changes: Partial<ManualCharacter>) {
    if (!allowPaidInputChange("character-profile-change")) return;
    commitManualCharacters(manualCharacters.map((character) => character.id === id ? { ...character, ...changes } : character));
    setCharacterError("");
  }

  function removeManualCharacter(character: ManualCharacter) {
    if (!allowPaidInputChange("character-profile-change")) return;
    if (!window.confirm(`确定删除角色“${character.name}”吗？相关分镜会恢复按剩余角色重新匹配。`)) return;
    const next = manualCharacters.filter((item) => item.id !== character.id);
    setManualCharacters(next);
    const nextCharacters = [...activeCharacters.filter((item) => !item.id.startsWith("extra-")), ...anchorsForManualCharacters(next)];
    setShots((items) => items.map((shot) => { const cleaned = { ...shot, characterIds: (shot.characterIds || []).filter((id) => id !== character.id), characterStageOverrides: Object.fromEntries(Object.entries(shot.characterStageOverrides || {}).filter(([id]) => id !== character.id)) }; return { ...cleaned, ...syncShotCharacters(cleaned, nextCharacters, effectiveStyle, ratio) }; }));
    setToast(`已删除角色“${character.name}”`);
  }

  function chooseManualCharacterReference(id: string) {
    if (!allowPaidInputChange("character-profile-change")) return;
    manualCharacterImportTarget.current = id;
    manualCharacterInput.current?.click();
  }

  function importManualCharacterReference(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = "";
    const id = manualCharacterImportTarget.current;
    manualCharacterImportTarget.current = "";
    if (!file || !id) return;
    if (!new Set(["image/png", "image/jpeg", "image/webp"]).has(file.type) || file.size > 12 * 1024 * 1024) { setToast("角色参考图仅支持 12 MB 以内的 PNG、JPEG 或 WebP"); return; }
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const dataUrl = String(reader.result ?? "");
        const saved = window.mujingDesktop && dataUrl ? await window.mujingDesktop.saveDataUrl({ dataUrl, prefix: `character-${id}` }) : { url: dataUrl };
        const next = manualCharacters.map((character) => character.id === id ? { ...character, referenceImage: saved.url, generatedImage: "" } : character);
        commitManualCharacters(next);
        setToast("角色参考图已导入并绑定到相关分镜");
      } catch (error) { setToast(error instanceof Error ? error.message : "角色参考图导入失败"); }
    };
    reader.onerror = () => setToast("无法读取这张角色参考图");
    reader.readAsDataURL(file);
  }

  async function chooseMusic() {
    try {
      if (window.mujingDesktop) {
        const result = await window.mujingDesktop.chooseMusic();
        if (result.canceled || !result.url) return;
        setMusicUrl(result.url);
        setMusicName(result.name || "背景音乐");
        setToast(`已加入背景音乐：${result.name || "背景音乐"}`);
        return;
      }
      musicInput.current?.click();
    } catch (error) {
      setToast(error instanceof Error ? error.message : "音乐导入失败");
    }
  }

  function importMusic(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 200 * 1024 * 1024) {
      setToast("音乐文件不能超过 200 MB");
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const dataUrl = String(reader.result ?? "");
        const saved = window.mujingDesktop && dataUrl ? await window.mujingDesktop.saveDataUrl({ dataUrl, prefix: "background-music" }) : { url: dataUrl };
        setMusicUrl(saved.url);
        setMusicName(file.name);
        setToast(`已加入背景音乐：${file.name}`);
      } catch (error) {
        setToast(error instanceof Error ? error.message : "音乐导入失败");
      }
    };
    reader.onerror = () => setToast("无法读取这个音乐文件");
    reader.readAsDataURL(file);
  }

  function removeMusic() {
    musicAudio.current?.pause();
    setMusicUrl("");
    setMusicName("");
    setToast("背景音乐已从项目中移除");
  }

  async function copyCharacterPrompt(prompt: string, name: string) {
    try {
      await window.navigator.clipboard.writeText(prompt);
      setToast(`已复制${name}的角色提示词`);
    } catch {
      setToast("复制失败，请手动选择提示词");
    }
  }

  async function generatePrimaryCharacterPrompt(noticeConfirmed = false) {
    const inferredProfile = inferPrimaryCharacterProfile(script);
    const resolvedName = PLACEHOLDER_CHARACTER_NAMES.has(characterName.trim()) ? inferredProfile.name : characterName;
    const validation = validateCharacterNames([
      { key: "primary", enabled: characterEnabled, name: resolvedName },
      { key: "secondary", enabled: secondaryCharacterEnabled, name: secondaryCharacterName },
      ...manualCharacters.map((character) => ({ key: character.id, enabled: character.enabled, name: character.name })),
    ]);
    if (!validation.ok) { setCharacterError(validation.message || "请先确认角色称呼"); setActiveStep(2); return; }
    if (resolvedName !== characterName) setCharacterName(resolvedName);
    if (!await ensurePaidTasksAllow("character-profile-change")) return;
    if (appSettings.mode === "live" && !noticeConfirmed) {
      requestGeneration({ title: "自动生成主角提示词", model: generationModel(providers.storyboard, "storyboard"), provider: providers.storyboard, itemCount: 1, uploads: `完整解说文稿、主角称呼“${resolvedName}”、识别到的年龄阶段与全片风格` }, () => { void generatePrimaryCharacterPrompt(true); });
      return;
    }
    const progressId = beginGenerationProgress("生成主角提示词", 1, `正在根据文稿设计“${resolvedName}”的固定身份…`);
    setBusy(true);
    setCharacterTask("prompt");
    setToast(`正在根据文稿设计${resolvedName}的跨镜头固定身份…`);
    try {
      if (appSettings.mode === "live" && !window.mujingDesktop) throw new Error("真实生成仅在安装版中可用。");
      const description = appSettings.mode === "live"
        ? (await window.mujingDesktop!.createCharacterProfile({ provider: providers.storyboard, script, name: resolvedName, style: effectiveStyle, stages: inferredProfile.stages })).description
        : createDemoCharacterDescription({ name: resolvedName, script });
      if (appSettings.mode === "demo") await wait(420);
      setCharacterDescription(description);
      setPrimaryGeneratedImage("");
      const nextPrompt = buildCharacterPrompt({ name: resolvedName, description, stages: inferredProfile.stages as CharacterStage[] }, effectiveStyle, Boolean(referenceImage));
      const nextCharacters = activeCharacters.map((character) => character.id === "primary" ? { ...character, name: resolvedName, description, aliases: inferredProfile.aliases, stages: inferredProfile.stages as CharacterStage[], firstPerson: inferredProfile.firstPerson, masterImage: referenceImage || undefined, prompt: nextPrompt } : character);
      setShots((items) => items.map((shot) => ({ ...shot, ...syncShotCharacters(shot, nextCharacters, effectiveStyle, ratio) })));
      finishGenerationProgress(progressId, `${resolvedName}的跨镜头固定身份提示词已生成`);
      setToast(`${resolvedName}的主角提示词已生成，已包含${inferredProfile.stages.map((stage: string) => characterStageLabel(stage as CharacterStage)).join("、")}一致性规则`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "主角提示词生成失败";
      failGenerationProgress(progressId, message);
      setToast(message);
    } finally {
      setCharacterTask(null);
      setBusy(false);
    }
  }

  async function generateCharacterImage(kind: CharacterKey, noticeConfirmed = false) {
    const manualCharacter = manualCharacters.find((character) => character.id === kind);
    const source = kind === "primary" ? referenceImage : kind === "secondary" ? secondaryReferenceImage : manualCharacter?.referenceImage || "";
    const inferredProfile = inferPrimaryCharacterProfile(script);
    const detectedPrimaryName = PLACEHOLDER_CHARACTER_NAMES.has(characterName.trim()) ? inferredProfile.name : characterName;
    const name = kind === "primary" ? detectedPrimaryName : kind === "secondary" ? secondaryCharacterName : manualCharacter?.name || "";
    const resolvedDescription = kind === "primary" && isGenericPrimaryDescription(characterDescription) ? createDemoCharacterDescription({ name, script }) : kind === "primary" ? characterDescription : kind === "secondary" ? secondaryCharacterDescription : manualCharacter?.description || "";
    const validation = validateCharacterNames([
      { key: "primary", enabled: characterEnabled, name: detectedPrimaryName },
      { key: "secondary", enabled: secondaryCharacterEnabled, name: secondaryCharacterName },
      ...manualCharacters.map((character) => ({ key: character.id, enabled: character.enabled, name: character.name })),
    ]);
    if (!validation.ok) { setCharacterError(validation.message || "请先确认角色称呼"); setActiveStep(2); return; }
    if (kind === "primary") {
      if (detectedPrimaryName !== characterName) setCharacterName(detectedPrimaryName);
      if (resolvedDescription !== characterDescription) setCharacterDescription(resolvedDescription);
    }
    if (!await ensurePaidTasksAllow("character-profile-change")) return;
    if (appSettings.mode === "live" && !noticeConfirmed) {
      requestGeneration({ title: kind === "primary" ? "生成主角身份母版" : "生成角色母版", model: generationModel(providers.image, "image"), provider: providers.image, itemCount: 1, uploads: source ? `角色“${name}”的已导入参考图、角色提示词与全片风格` : `角色“${name}”的文字提示词与全片风格（没有上传图片）` }, () => { void generateCharacterImage(kind, true); });
      return;
    }
    const progressId = beginGenerationProgress(kind === "primary" ? "生成主角身份母版" : `生成${name}身份母版`, 1, `正在生成“${name}”的角色参考图…`);
    setBusy(true);
    setCharacterTask("image");
    setToast(`正在生成${name}的参考图…`);
    try {
      let generated = source || "";
      if (appSettings.mode === "live") {
        if (!window.mujingDesktop) throw new Error("真实生成仅在安装版中可用。");
        const prompt = kind === "primary" ? buildCharacterPrompt({ name, description: resolvedDescription, stages: inferredProfile.stages as CharacterStage[] }, effectiveStyle, Boolean(source)) : kind === "secondary" ? secondaryCharacterPrompt : buildCharacterPrompt({ name, description: resolvedDescription, stages: ["adult"] }, effectiveStyle, Boolean(source));
        generated = (await window.mujingDesktop.createImage({ provider: providers.image, prompt, ratio: "9:16", ...(source ? { imageUrl: source, references: [source] } : {}) })).url;
      } else {
        await wait(620);
        if (!generated) {
          const dataUrl = createDemoCharacterReference(name, resolvedDescription);
          generated = window.mujingDesktop && dataUrl ? (await window.mujingDesktop.saveDataUrl({ dataUrl, prefix: `character-${kind}-generated` })).url : dataUrl;
        }
      }
      if (!generated) throw new Error("角色参考图生成失败，请重试。");
      if (kind === "primary") setPrimaryGeneratedImage(generated);
      else if (kind === "secondary") setSecondaryGeneratedImage(generated);
      else setManualCharacters((items) => items.map((character) => character.id === kind ? { ...character, generatedImage: generated } : character));
      const nextCharacters = activeCharacters.map((character) => character.id === kind ? { ...character, name, description: resolvedDescription, masterImage: generated, ...(kind === "primary" ? { aliases: inferredProfile.aliases, stages: inferredProfile.stages as CharacterStage[], firstPerson: inferredProfile.firstPerson } : {}) } : character);
      setShots((items) => items.map((shot) => ({ ...shot, ...syncShotCharacters(shot, nextCharacters, effectiveStyle, ratio) })));
      finishGenerationProgress(progressId, `${name}的身份母版已生成并绑定到相关分镜`);
      setToast(`${name}的身份母版已强制应用到所有相关分镜；缺少母版的镜头将不再允许生成`);
    } catch (error) { const message = error instanceof Error ? error.message : "角色图生成失败"; failGenerationProgress(progressId, message); setToast(message); }
    finally { setCharacterTask(null); setBusy(false); }
  }

  function alignVoiceTimeline(duration: number) {
    const localGuard = guardPaidTaskDestruction(shots, "voice-timing-change");
    if (!localGuard.allowed) {
      setVoiceTimelineAligned(false);
      setToast(`${localGuard.reason} 配音已保留，但暂未改变时间线。`);
      return false;
    }
    const hasReadyVideo = shots.some((shot) => shot.videoState === "ready" && Boolean(shot.videoUrl));
    const alignment = alignShotsToVoice(shots, duration, { preserveExistingVideoLengths: hasReadyVideo });
    if (!alignment.ok) {
      setVoiceTimelineAligned(false);
      setToast(alignment.reason || "配音时间线自动对齐失败");
      return false;
    }
    setShots(alignment.shots);
    setPlayhead(0);
    setVoiceTimelineAligned(true);
    return true;
  }

  async function generateVoice(noticeConfirmed = false) {
    if (!script.trim()) { setToast("请先填写解说文稿"); return; }
    if (!window.mujingDesktop) { setToast("配音生成请在幕境安装版中使用"); return; }
    const selectedVoice = providers.voice === "ElevenLabs" ? appSettings.elevenlabs.voice.trim() : voiceId;
    if (appSettings.mode === "live" && providers.voice === "ElevenLabs" && (!selectedVoice || (!appSettings.elevenlabs.apiKey && !appSettings.elevenlabs.hasKey))) {
      setSettingsOpen(true);
      setToast(!selectedVoice ? "请先填写 ElevenLabs Voice ID" : "请先填写 ElevenLabs API Key");
      return;
    }
    if (appSettings.mode === "live" && !noticeConfirmed) {
      requestGeneration({ title: "生成解说配音并自动对齐", model: generationModel(providers.voice, "voice"), provider: providers.voice, itemCount: 1, uploads: `完整解说文稿、朗读节奏指令与所选音色（${providers.voice === "ElevenLabs" ? `Voice ID ${selectedVoice}` : selectedVoice}）；生成后会按真实音频时长重排字幕和镜头边界` }, () => { void generateVoice(true); });
      return;
    }
    const progressId = beginGenerationProgress("生成解说配音并对齐", 1, `正在使用${appSettings.mode === "live" ? providers.voice : "Windows 本地语音"}生成配音…`);
    setVoiceState("generating");
    try {
      const result = appSettings.mode === "live"
        ? await window.mujingDesktop.createSpeech({ provider: providers.voice, voice: selectedVoice, text: script, instructions: pace === "舒缓" ? "使用舒缓、有感染力的普通话朗读。" : pace === "紧凑" ? "使用清晰、略快、有推动感的普通话朗读。" : "使用自然、清晰、有叙事感的普通话朗读。" })
        : await window.mujingDesktop.createDemoSpeech({ text: script });
      setVoiceUrl(result.url);
      setVoiceProvenance(result.provenance);
      const aligned = alignVoiceTimeline(result.provenance.duration);
      setVoiceState(aligned ? "ready" : "error");
      if (aligned) { finishGenerationProgress(progressId, `配音已生成，字幕与画面已按 ${formatTime(result.provenance.duration)} 对齐`); setToast(`${appSettings.mode === "live" ? `${providers.voice} 配音` : "Windows 本地配音"}已生成，并按真实时长 ${formatTime(result.provenance.duration)} 对齐字幕与画面`); }
      else failGenerationProgress(progressId, "配音已生成，但时间线自动对齐失败");
    } catch (error) {
      setVoiceState("error");
      const message = error instanceof Error ? error.message : "配音生成失败";
      failGenerationProgress(progressId, message);
      setToast(message);
    }
  }

  async function saveModelSettings() {
    if (appSettings.mode === "live" && !window.mujingDesktop) { setToast("API 密钥只能在安装版中安全保存"); return; }
    try {
      if (window.mujingDesktop) {
        const saved = await window.mujingDesktop.saveSettings(appSettings);
        setAppSettings({
          mode: saved.mode,
          openai: { ...appSettings.openai, ...saved.openai, apiKey: "", clearApiKey: false },
          custom: { ...appSettings.custom, ...saved.custom, apiKey: "", clearApiKey: false },
          elevenlabs: { ...appSettings.elevenlabs, ...saved.elevenlabs, apiKey: "", clearApiKey: false },
          comfyui: { ...appSettings.comfyui, ...saved.comfyui, apiKey: "", clearApiKey: false },
        });
      }
      setSettingsOpen(false);
      setToast(appSettings.mode === "live" ? "API 设置已加密保存" : "已切换为演示模式");
    } catch (error) { setToast(error instanceof Error ? error.message : "设置保存失败"); }
  }

  async function testApiConnection(section: ProviderSection = "openai") {
    if (!window.mujingDesktop) { setToast("连接测试请在安装版中使用"); return; }
    setTestingConnection(true);
    try {
      const result = await window.mujingDesktop.testConnection({ ...appSettings, section } as AppSettings);
      if (section === "custom") {
        const endpoint = /^ep-/i.test(result.model || "");
        setToast(endpoint
          ? `方舟连接与 API Key 有效；Endpoint ID 格式正确。连接检查不会提交付费视频任务，请确认该 Endpoint 已在控制台启用 Seedance`
          : result.modelVisible
            ? `方舟连接成功，账户模型列表已识别 ${result.model}`
            : `方舟连接与 API Key 有效，但账户模型列表未识别 ${result.model || "当前 Seedance ID"}；请改用公开模型或控制台复制的 ep-…`);
      } else if (section === "elevenlabs") {
        setToast(`ElevenLabs 连接成功，当前 Voice ID 可用；测试未生成音频，也未消耗配音字符`);
      } else if (section === "comfyui") {
        setToast(`ComfyUI 连接成功：${result.gpuName || "本地设备"}${result.vramGb ? ` · ${result.vramGb}GB 显存` : ""} · ${result.workflow || "工作流可用"}`);
      } else setToast(`连接成功${result.models ? `，检测到 ${result.models} 个模型` : ""}`);
    } catch (error) { setToast(error instanceof Error ? error.message : "连接失败"); }
    finally { setTestingConnection(false); }
  }

  function updateProviderConfig(section: ProviderSection, key: keyof ApiProviderConfig, value: string) {
    setAppSettings((current) => ({ ...current, [section]: { ...current[section], [key]: value, ...(key === "apiKey" ? { clearApiKey: false } : {}) } }));
  }

  function clearProviderKey(section: ProviderSection) {
    if (!window.confirm("明确清除已保存的 API Key？保存设置后生效，之后真实请求将无法使用该服务商，直到输入新密钥。")) return;
    setAppSettings((current) => ({ ...current, [section]: { ...current[section], apiKey: "", clearApiKey: true } }));
    setToast("已标记清除密钥；点击“保存设置”后才会删除加密存储中的旧密钥");
  }

  async function chooseComfyUIWorkflow() {
    if (!window.mujingDesktop) { setToast("请在安装版中导入 ComfyUI 工作流"); return; }
    try {
      const result = await window.mujingDesktop.chooseComfyUIWorkflow();
      if (!result.canceled && result.path) {
        updateProviderConfig("comfyui", "workflowPath", result.path);
        updateProviderConfig("comfyui", "videoModel", "custom-workflow");
        setToast(`已导入 ${result.name || "ComfyUI API 工作流"}；请保存设置并测试连接`);
      }
    } catch (error) { setToast(error instanceof Error ? error.message : "工作流导入失败"); }
  }

  function changeVoiceSelection(nextVoice: string) {
    setVoiceId(nextVoice);
    if (voiceUrl) {
      setVoiceTimelineAligned(false);
      setVoiceState("idle");
      setToast("音色已更换，请重新生成配音；旧音频暂时保留用于对比，导出前必须重新对齐");
    }
  }

  function changeElevenLabsVoiceId(nextVoice: string) {
    updateProviderConfig("elevenlabs", "voice", nextVoice);
    if (voiceUrl) {
      setVoiceTimelineAligned(false);
      setVoiceState("idle");
      setToast("ElevenLabs Voice ID 已更换，请重新生成配音并对齐时间线");
    }
  }

  function changeProviderSelection(key: keyof Providers, value: string) {
    setProviders({ ...providers, [key]: value });
    if (key === "voice" && value !== providers.voice && voiceUrl) {
      setVoiceTimelineAligned(false);
      setVoiceState("idle");
      setToast("配音服务已更换，请重新生成配音并自动对齐时间线");
    }
  }

  async function exportMp4() {
    if (!window.mujingDesktop) { setToast("MP4 导出请在幕境安装版中使用"); return; }
    if (exportBlockReason) { setToast(`${exportBlockReason}，暂不能导出成片`); return; }
    const progressId = beginGenerationProgress("渲染完整成片", shots.length, `正在准备 ${shots.length} 个镜头、配音、字幕${musicUrl ? "和背景音乐" : ""}…`);
    setRendering(true);
    try {
      const result = await window.mujingDesktop.exportVideo({ ...exportPayload, musicVolume: musicVolume / 100 });
      if (!result.canceled) {
        setExportOpen(false);
        finishGenerationProgress(progressId, "完整 MP4 已渲染并保存到所选位置");
        setToast(`完整视频已导出${result.outputPath ? `：${result.outputPath}` : ""}`);
      } else cancelGenerationProgress(progressId, "已取消导出，没有覆盖现有文件");
    } catch (error) { const message = error instanceof Error ? error.message : "视频导出失败"; failGenerationProgress(progressId, message); setToast(message); }
    finally { setRendering(false); }
  }

  function finishExport() {
    setExportOpen(false);
    setToast("项目制作包已下载");
  }

  function openExport() {
    if (exportBlockReason) { setToast(`${exportBlockReason}，暂不能导出成片`); return; }
    setExportOpen(true);
  }

  function startProjectNameEdit() {
    setProjectNameDraft(projectName);
    setEditingProjectName(true);
  }

  function commitProjectName() {
    const name = projectNameDraft.trim();
    if (name) setProjectName(name);
    setEditingProjectName(false);
  }

  if (!hydrated) {
    return <main className="restore-screen"><span className="brand-mark">幕</span><div><b>正在恢复项目</b><small>读取文稿、分镜和时间轴…</small></div></main>;
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <button className="brand" onClick={() => setActiveStep(1)} aria-label="幕境首页">
          <span className="brand-mark">幕</span><span>幕境</span>{appVersion && <span className="brand-tag">{appVersion}</span>}
        </button>
        <div className="project-title">
          <span className="status-dot" />
          {editingProjectName ? <input ref={projectNameInput} className="project-name-input" value={projectNameDraft} maxLength={80} onChange={(event) => setProjectNameDraft(event.target.value)} onBlur={commitProjectName} onKeyDown={(event) => { if (event.key === "Enter") commitProjectName(); if (event.key === "Escape") setEditingProjectName(false); }} aria-label="项目名称" /> : <>
            <button className="project-name-button" onClick={startProjectNameEdit} title="点击修改项目名称">{projectName}</button>
            <button className="rename-button" onClick={startProjectNameEdit} aria-label="重命名项目">✎</button>
          </>}
        </div>
        <div className="top-actions">
          <button className="global-style-control" onClick={() => setStyleOpen(true)}><span className={`style-swatch ${activeStyle.tone}`} /><span><small>全片风格</small><b>{style}</b></span><em>⌄</em></button>
          <span className={`save-state ${saveState}`} role="status" aria-live="polite">{saveState === "error" ? "保存失败 · 点击重试" : saveState === "saving" ? "正在保存…" : saveState === "dirty" ? "存在未保存修改" : `已自动保存 · ${lastSavedAt}`}{saveState === "error" && <button onClick={retrySave}>重试保存</button>}</span>
          <button className="ghost-button" onClick={() => shots.length ? setActiveStep(5) : setToast("请先生成分镜")}>预览项目</button>
          <span className="export-control"><button className="export-button" aria-disabled={Boolean(exportBlockReason)} aria-describedby="export-disabled-reason" onClick={openExport}>导出成片 <span>↗</span></button>{exportBlockReason && <small id="export-disabled-reason" role="status">{exportBlockReason}，暂不能导出</small>}</span>
        </div>
      </header>

      <aside className="sidebar">
        <div className="sidebar-heading">创作流程</div>
        <nav className="step-list" aria-label="创作流程">
          {workflowSteps.map((step) => (
            <button className={`step-item ${activeStep === step.id ? "active" : ""} ${step.id > 2 && !shots.length ? "locked" : ""}`} key={step.id} onClick={() => step.id <= 2 || shots.length ? setActiveStep(step.id) : setToast("请先生成分镜草案")}>
              <span className="step-number">{step.number}</span>
              <span className="step-copy"><strong>{step.label}</strong><small>{step.detail}</small></span>
              {activeStep === step.id && <span className="step-arrow">›</span>}
            </button>
          ))}
        </nav>
        <div className="project-health">
          <div className="health-title"><span>◈</span> 项目进度</div>
          <div className="health-row"><span>{activeStep === 5 ? "已准备导出" : workflowSteps[activeStep - 1].detail}</span><b>{progress}%</b></div>
          <div className="progress"><i style={{ width: `${progress}%` }} /></div>
          <p>{shots.length ? `${shots.length} 个镜头 · ${formatTime(totalDuration)} · ${approvedCount} 个已确认` : "识别文稿角色并确认角色档案后，再生成完整分镜。"}</p>
        </div>
        <button className="settings-link" onClick={() => setSettingsOpen(true)}><span>⌘</span> 模型与偏好设置</button>
        <button className="data-notice-link" onClick={() => setDataNoticeOpen(true)}><span>i</span> 数据与费用说明</button>
        <input ref={projectPackageInput} className="hidden-input" type="file" accept=".story,.json,.story.json,application/json" onChange={(event) => void importProjectPackage(event)} />
        <button className="project-import-button" onClick={() => projectPackageInput.current?.click()}><span>↑</span> 导入项目制作包</button>
        <form className="project-package-form" action="/api/export" method="post" onSubmit={() => setToast("正在另存 .story 项目制作包")}><input type="hidden" name="payload" value={exportPayloadString} /><button type="submit"><span>↓</span> 另存项目制作包</button></form>
      </aside>

      <section className={`workspace workspace-step-${activeStep}`}>
        {activeStep === 1 && (
          <>
            <div className="workspace-heading">
              <div><StageLabel step={1} /><h1>{creationMode === "short_drama" ? "从一场有冲突的戏开始" : "从一段好故事开始"}</h1><p>{creationMode === "short_drama" ? "输入场景、动作和角色对白；AI 会识别说话人、群众与镜头反打，横版和竖版都可制作。" : "粘贴解说文稿，先识别故事角色；确认角色档案后，再设计可制作的分镜。"}</p></div>
              <div className="duration-card"><span>预估成片</span><strong>{formatTime(draftDuration)}</strong><small>约 {Math.max(3, scriptBeats.length)} 个镜头 · {creationMode === "short_drama" ? `${detectedDramaCharacters.length} 个对白角色 · ${ratio}` : "随叙事节奏变化"}</small></div>
            </div>
            <div className="creation-mode-switch" aria-label="创作模式"><button className={creationMode === "narration" ? "selected" : ""} onClick={() => void updateCreationMode("narration")}><span>文</span><b>解说视频</b><small>旁白驱动的故事与知识视频</small></button><button className={creationMode === "short_drama" ? "selected" : ""} onClick={() => void updateCreationMode("short_drama")}><span>剧</span><b>短剧模式</b><small>场景、动作、角色对白 · 横竖版均可</small></button></div>
            <div className="editor-grid">
              <section className="script-card">
                <div className="card-toolbar"><div><span className="live-dot" /> {creationMode === "short_drama" ? "短剧剧本" : "解说文稿"}</div><div className="toolbar-actions">{creationMode === "short_drama" && <button onClick={() => void loadShortDramaExample()}>载入短剧示例</button>}<button onClick={() => fileInput.current?.click()}>导入{creationMode === "short_drama" ? "剧本" : "文稿"}</button>{undoClearedScript !== null && <button className="undo-action" onClick={restoreClearedScript}>撤销清空</button>}<span className="divider" /><button onClick={clearScript}>清空</button></div></div>
                <input ref={fileInput} className="hidden-input" type="file" accept=".txt,.md,text/plain" onChange={importScript} />
                <textarea value={script} onChange={(event) => updateScript(event.target.value)} aria-label={creationMode === "short_drama" ? "短剧剧本" : "解说文稿"} placeholder={creationMode === "short_drama" ? "例如：\n场景：公司会议室／白天\n\n林夏推门走进来。\n\n林夏：这个项目，我不会退出。" : "在这里粘贴你的解说文稿……"} />
                <div className="script-footer"><div className="script-stats"><span><b>{script.replace(/\s/g, "").length}</b> 字</span><span><b>{script.split(/\n+/).filter(Boolean).length}</b> {creationMode === "short_drama" ? "行" : "段"}</span>{creationMode === "short_drama" && <span><b>{detectedDramaCharacters.length}</b> 个说话人</span>}<span><b>{draftDuration}</b> 秒</span></div><span className="quality"><i>✓</i> {creationMode === "short_drama" ? detectedDramaCharacters.length ? "已识别角色对白" : "可用“角色：台词”标记对白" : script.length > 40 ? "叙事结构清晰" : "继续补充内容"}</span></div>
              </section>
              <aside className="brief-card">
                <div className="brief-heading"><span className="spark">✦</span><div><strong>创作设定</strong><small>{creationMode === "short_drama" ? "短剧可自由选择竖版或横版" : "决定整条视频的视觉方向"}</small></div></div>
                <label className="field-label">画面比例</label>
                <div className="ratio-options"><button className={ratio === "16:9" ? "selected" : ""} onClick={() => updateRatio("16:9")}><span className="ratio-landscape" />16:9 横屏</button><button className={ratio === "9:16" ? "selected" : ""} onClick={() => updateRatio("9:16")}><span className="ratio-portrait" />9:16 竖屏</button></div>
                <label className="field-label">全片视频风格</label>
                <div className="style-mini-grid">{videoStyles.map((option) => <button key={option.name} className={style === option.name ? "selected" : ""} onClick={() => applyGlobalStyle(option.name)}><span className={`style-swatch ${option.tone}`} /><b>{option.name}</b></button>)}</div>
                <button className="style-detail-link" onClick={() => setStyleOpen(true)}>查看风格说明与自定义选项　→</button>
                <label className="field-label">叙事节奏</label>
                <div className="pace-options">{["舒缓", "自然", "紧凑"].map((item) => <button key={item} className={pace === item ? "selected" : ""} onClick={() => setPace(item)}>{item}</button>)}</div>
                <label className="field-label">角色阵容</label>
                <button className="character-add" onClick={() => setActiveStep(2)}><span>＋</span><div><b>{activeCharacters.length ? `${activeCharacters.length} 个角色 · ${activeCharacters.map((character) => character.name).join("、")}` : "添加角色参考"}</b><small>为不同人物分别锁定外貌与服装</small></div></button>
                <button className="primary-action" onClick={identifyCharactersAndContinue}><span><b>{creationMode === "short_drama" ? "识别说话人并继续" : "识别角色并继续"}</b><small>{creationMode === "short_drama" ? "下一步确认主配角和群众设定" : "下一步确认角色，再生成分镜"}</small></span><em>→</em></button>
              </aside>
            </div>
            <div className="tipbar"><span>i</span><p><b>创作建议</b>　{creationMode === "short_drama" ? "使用“场景：…”和“角色：台词”会让说话人、反打镜头和群众调度更准确；生成后仍可逐镜修正。" : "完整的句子和明确的段落能让分镜节奏更自然。生成后，每个镜头都可以单独修改。"}</p></div>
          </>
        )}

        {activeStep === 2 && (
          <>
            <div className="workspace-heading"><div><StageLabel step={2} /><h1>让每个角色都清晰可辨</h1><p>分别建立角色档案。后续分镜会按剧情选择出镜人物，并保持各自的外貌、服装与气质一致。</p></div><button className="heading-action" onClick={() => setActiveStep(shots.length ? 3 : 1)}>{shots.length ? "进入分镜" : "返回文稿"}　→</button></div>
            <div className="character-layout">
              <section className="character-preview-card">
                <div className={`character-portrait ${primaryGeneratedImage || referenceImage ? "has-image" : ""}`} style={primaryGeneratedImage || referenceImage ? { backgroundImage: `url(${primaryGeneratedImage || referenceImage})` } : undefined}>
                  {!primaryGeneratedImage && !referenceImage && <><span className="portrait-head" /><span className="portrait-body" /><b>主角参考图</b></>}
                </div>
                <input ref={characterInput} className="hidden-input" type="file" accept="image/*" onChange={importCharacter} />
                <button className="upload-reference" onClick={() => { if (allowPaidInputChange("character-profile-change")) characterInput.current?.click(); }}>导入人物参考图</button>
                <div className="secondary-reference">
                  <div className={`secondary-avatar ${secondaryGeneratedImage || secondaryReferenceImage ? "has-image" : ""}`} style={secondaryGeneratedImage || secondaryReferenceImage ? { backgroundImage: `url(${secondaryGeneratedImage || secondaryReferenceImage})` } : undefined}>{!secondaryGeneratedImage && !secondaryReferenceImage && <span>02</span>}</div>
                  <div><b>{secondaryCharacterName}</b><small>第二角色参考</small></div>
                  <input ref={secondaryCharacterInput} className="hidden-input" type="file" accept="image/*" onChange={importSecondaryCharacter} />
                  <button onClick={() => { if (allowPaidInputChange("character-profile-change")) secondaryCharacterInput.current?.click(); }}>导入</button>
                </div>
                <input ref={manualCharacterInput} className="hidden-input" type="file" accept="image/png,image/jpeg,image/webp" onChange={importManualCharacterReference} />
                {manualCharacters.map((character, index) => { const image = character.generatedImage || character.referenceImage; return <div className="secondary-reference" key={character.id}>
                  <div className={`secondary-avatar ${image ? "has-image" : ""}`} style={image ? { backgroundImage: `url(${image})` } : undefined}>{!image && <span>{String(index + 3).padStart(2, "0")}</span>}</div>
                  <div><b>{character.name}</b><small>手动角色参考</small></div>
                  <button onClick={() => chooseManualCharacterReference(character.id)}>导入</button>
                </div>; })}
                <p>可以直接用主角提示词生成参考图，也可以导入正面、光线均匀、无遮挡的单人照片作为身份基础。</p>
              </section>
              <section className="character-form-card">
                <div className="section-title-row"><div><span className="spark small">人</span><div><strong>主要人物设定</strong><small>已从文稿识别：{primaryCharacterAnalysis.name} · {primaryStages.map(characterStageLabel).join(" / ")}</small></div></div><label className="switch-label"><input type="checkbox" checked={characterEnabled} onChange={(event) => updateCharacterProfile(() => setCharacterEnabled(event.target.checked))} /><span />{characterEnabled ? "已启用" : "未启用"}</label></div>
                <div className="form-grid">
                  <label><span>角色称呼</span><input ref={characterNameInput} aria-label="主要角色称呼" aria-invalid={Boolean(characterError && characterValidation.invalidKey === "primary")} aria-describedby={characterError ? "character-validation-error" : undefined} value={characterName} onChange={(event) => updateCharacterProfile(() => { setCharacterName(event.target.value); setCharacterError(""); })} /></label>
                  <label><span>人物类型</span><select><option>虚构人物</option><option>已获授权的真人</option><option>非人物角色</option></select></label>
                  <label className="full"><span>不可改变的外观特征</span><textarea aria-label="主要角色外观特征" value={characterDescription} onChange={(event) => updateCharacterProfile(() => setCharacterDescription(event.target.value))} /></label>
                </div>
                <div className="character-prompt-card" aria-live="polite">
                  <div className="character-prompt-heading"><div><span>✦</span><b>主角提示词</b><small>{style} · {primaryGeneratedImage || referenceImage ? "身份母版已绑定" : primaryStages.length > 1 ? "已设计跨年龄身份母版" : "根据文稿自动设计"}</small></div><div className="character-prompt-actions"><button disabled={busy} onClick={() => void generatePrimaryCharacterPrompt()}>{characterTask === "prompt" ? "生成提示词…" : "自动生成提示词"}</button><button onClick={() => copyCharacterPrompt(primaryCharacterPrompt, characterName)}>复制</button><button className="generate-character-button" disabled={busy} onClick={() => generateCharacterImage("primary")}>{characterTask === "image" ? "正在锁定主角…" : primaryGeneratedImage ? "重新生成身份母版" : "一键锁定主角母版"}</button></div></div>
                  <p>{primaryCharacterPrompt}</p><small className="prompt-sync-note">提示词会根据文稿、角色称呼、外观特征和全片风格生成；内容可在上方继续修改。</small>
                </div>
                {primaryGeneratedImage && <button className="character-result-card" onClick={() => setCharacterPreview({ name: characterName, src: primaryGeneratedImage, prompt: primaryCharacterPrompt })}><img src={primaryGeneratedImage} alt={`${characterName}主角参考图预览`} /><span><b>{characterName} · 主角参考图</b><small>{providers.image} · 已应用到相关分镜</small><em>点击放大 ↗</em></span></button>}
                <div className="character-section-divider" />
                <div className="section-title-row secondary-title"><div><span className="spark small secondary-spark">02</span><div><strong>第二人物设定</strong><small>与主要人物保持明显差异</small></div></div><label className="switch-label"><input type="checkbox" checked={secondaryCharacterEnabled} onChange={(event) => updateCharacterProfile(() => setSecondaryCharacterEnabled(event.target.checked))} /><span />{secondaryCharacterEnabled ? "已启用" : "未启用"}</label></div>
                <div className="form-grid">
                  <label><span>角色称呼</span><input ref={secondaryCharacterNameInput} aria-label="第二角色称呼" aria-invalid={Boolean(characterError && characterValidation.invalidKey === "secondary")} aria-describedby={characterError ? "character-validation-error" : undefined} value={secondaryCharacterName} onChange={(event) => updateCharacterProfile(() => { setSecondaryCharacterName(event.target.value); setCharacterError(""); })} /></label>
                  <label><span>人物类型</span><select aria-label="第二角色类型"><option>虚构人物</option><option>已获授权的真人</option><option>非人物角色</option></select></label>
                  <label className="full"><span>不可改变的外观特征</span><textarea aria-label="第二角色外观特征" value={secondaryCharacterDescription} onChange={(event) => updateCharacterProfile(() => setSecondaryCharacterDescription(event.target.value))} /></label>
                </div>
                {secondaryCharacterEnabled && <>
                  <div className="character-prompt-card secondary-prompt" aria-live="polite">
                    <div className="character-prompt-heading"><div><span>✦</span><b>第二角色提示词</b><small>{style} · {secondaryGeneratedImage || secondaryReferenceImage ? "身份母版已绑定" : "根据角色档案自动设计"}</small></div><div className="character-prompt-actions"><button onClick={() => copyCharacterPrompt(secondaryCharacterPrompt, secondaryCharacterName)}>复制提示词</button><button className="generate-character-button" disabled={busy} onClick={() => generateCharacterImage("secondary")}>{characterTask === "image" ? "正在锁定第二角色…" : secondaryGeneratedImage ? "重新生成身份母版" : "一键锁定第二角色母版"}</button></div></div>
                    <p>{secondaryCharacterPrompt}</p><small className="prompt-sync-note">该提示词会单独约束第二角色，不会覆盖主要人物。</small>
                  </div>
                  {secondaryGeneratedImage && <button className="character-result-card secondary-result" onClick={() => setCharacterPreview({ name: secondaryCharacterName, src: secondaryGeneratedImage, prompt: secondaryCharacterPrompt })}><img src={secondaryGeneratedImage} alt={`${secondaryCharacterName}角色生成预览`} /><span><b>{secondaryCharacterName} · 角色母版</b><small>{providers.image} · 已应用到相关分镜</small><em>点击放大 ↗</em></span></button>}
                </>}
                {manualCharacters.map((character, index) => { const prompt = buildCharacterPrompt({ name: character.name, description: character.description, stages: ["adult"] }, effectiveStyle, Boolean(character.generatedImage || character.referenceImage)); const image = character.generatedImage || character.referenceImage; return <div className="manual-character-section" key={character.id}>
                  <div className="character-section-divider" />
                  <div className="section-title-row secondary-title"><div><span className="spark small manual-spark">{String(index + 3).padStart(2, "0")}</span><div><strong>手动角色设定</strong><small>可在每个分镜中手动选择是否出镜</small></div></div><div className="manual-character-actions"><label className="switch-label"><input type="checkbox" checked={character.enabled} onChange={(event) => updateManualCharacter(character.id, { enabled: event.target.checked })} /><span />{character.enabled ? "已启用" : "未启用"}</label><button className="remove-character-button" onClick={() => removeManualCharacter(character)}>删除</button></div></div>
                  <div className="form-grid">
                    <label><span>角色称呼</span><input aria-label={`手动角色 ${index + 3} 称呼`} aria-invalid={Boolean(characterError && characterValidation.invalidKey === character.id)} value={character.name} onChange={(event) => updateManualCharacter(character.id, { name: event.target.value })} /></label>
                    <label><span>人物类型</span><select aria-label={`${character.name}人物类型`}><option>虚构人物</option><option>已获授权的真人</option><option>非人物角色</option></select></label>
                    <label className="full"><span>不可改变的外观特征</span><textarea aria-label={`${character.name}外观特征`} value={character.description} onChange={(event) => updateManualCharacter(character.id, { description: event.target.value })} /></label>
                  </div>
                  {character.enabled && <><div className="character-prompt-card manual-character-prompt" aria-live="polite"><div className="character-prompt-heading"><div><span>✦</span><b>{character.name}提示词</b><small>{style} · {image ? "身份母版已绑定" : "根据角色档案自动设计"}</small></div><div className="character-prompt-actions"><button onClick={() => chooseManualCharacterReference(character.id)}>导入参考图</button><button onClick={() => copyCharacterPrompt(prompt, character.name)}>复制提示词</button><button className="generate-character-button" disabled={busy} onClick={() => generateCharacterImage(character.id)}>{characterTask === "image" ? "正在生成…" : character.generatedImage ? "重新生成身份母版" : "生成身份母版"}</button></div></div><p>{prompt}</p><small className="prompt-sync-note">该角色会参与自动识别，也可以在任意分镜中手动选中或取消。</small></div>{image && <button className="character-result-card secondary-result" onClick={() => setCharacterPreview({ name: character.name, src: image, prompt })}><img src={image} alt={`${character.name}角色参考图预览`} /><span><b>{character.name} · 角色母版</b><small>{character.generatedImage ? providers.image : "本地导入"} · 已应用到相关分镜</small><em>点击放大 ↗</em></span></button>}</>}
                </div>; })}
                <button className="add-manual-character-button" disabled={manualCharacters.length >= 8 || busy} onClick={addManualCharacter}><span>＋</span><b>手动增加角色</b><small>最多增加 8 个角色，可分别设置提示词与身份母版</small></button>
                {characterError && <p id="character-validation-error" className="character-error" role="alert">{characterError}</p>}
                <div className="consistency-grid">
                  <div><span>01</span><b>身份母版</b><p>先从文稿找到主角，再锁定脸部结构与标志特征。</p></div>
                  <div><span>02</span><b>年龄阶段</b><p>童年与成年共享遗传特征，只做自然年龄变化。</p></div>
                  <div><span>03</span><b>强制绑定</b><p>主角出镜却没有母版时，系统会阻止生成。</p></div>
                </div>
                <div className="form-actions"><button className="ghost-button" onClick={() => setToast(`已保存 ${activeCharacters.length} 个角色档案`)}>保存角色</button><button className="primary-inline" disabled={busy} onClick={() => { if (!shots.length) runGenerateStoryboard(); else setActiveStep(3); }}>{busy ? "正在生成分镜…" : shots.length ? "保存并进入分镜　→" : "生成分镜并继续　→"}</button></div>
              </section>
            </div>
          </>
        )}

        {activeStep === 3 && (
          <>
            <div className="workspace-heading storyboard-heading"><div><StageLabel step={3} /><h1>故事板已经铺开</h1><p>{shots.length} 个镜头，预计 {formatTime(totalDuration)}。先调整画面描述，确认后再投入生成。</p></div><div className="heading-buttons">{undoClearedStoryboard && <button className="undo-action" onClick={restoreClearedStoryboard}>撤销清空全部分镜</button>}<button className="danger-ghost-button" onClick={() => void confirmClearStoryboard()}>清空全部分镜</button><button className="ghost-button" onClick={() => void redesignStoryboard()}>重新设计</button><button className="heading-action" disabled={allShotsApproved} onClick={() => setShots((items) => items.map((shot) => ({ ...shot, approved: true })))}>{allShotsApproved ? "已全部确认 ✓" : "全部确认"}</button></div></div>
            <div className="storyboard-list">
              {shots.map((shot, index) => (
                <article className={`shot-card ${shot.approved ? "approved" : ""}`} key={shot.id}>
                  <div className="shot-index"><span>{String(index + 1).padStart(2, "0")}</span><i /><small>{formatTime(shot.start)}—{formatTime(shot.end)}</small></div>
                  <SceneArt shot={shot} className={ratio === "9:16" ? "ratio-portrait-media" : "ratio-landscape-media"} />
                  <div className="shot-content">
                    <div className="shot-meta">
                      <label className="shot-size-control"><span>景别</span><select aria-label={`镜头 ${index + 1} 景别`} value={shot.shotType} disabled={busy} onChange={(event) => updateShotType(shot, event.target.value)}>{[...new Set([shot.shotType, ...shotSizeOptions])].filter(Boolean).map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
                      <span className="shot-camera-label">{shot.camera}</span><b>{shot.duration}s</b>
                    </div>
                    <blockquote>“{shot.narration}”</blockquote>
                    <label><span>画面描述</span><textarea value={shot.visual} onChange={(event) => updateShotVisual(shot, event.target.value)} /></label>
                    {creationMode === "short_drama" && <div className="drama-shot-context"><label><span>所属场景</span><input value={shot.scene || ""} placeholder="例如：公司会议室／白天" onChange={(event) => updateShotDramaContext(shot, { scene: event.target.value })} /></label><label><span>说话人</span><select value={shot.speaker || ""} onChange={(event) => updateShotDramaContext(shot, { speaker: event.target.value })}><option value="">无／动作镜头</option>{activeCharacters.map((character) => <option key={character.id} value={character.name}>{character.name}</option>)}</select></label><label><span>群众演员</span><input value={shot.extras || ""} placeholder="例如：6 名办公室职员" onChange={(event) => updateShotDramaContext(shot, { extras: event.target.value })} /></label>{shot.dialogue && <p><b>{shot.speaker || "对白"}</b><span>{shot.dialogue}</span><small>对白只驱动表演，不会生成在画面里</small></p>}</div>}
                    {(() => { const referencedCharacters = referencedCharactersForShot(shot); const boundCharacters = boundCharactersForShot(shot); return <div className={`shot-character-refs ${boundCharacters.length ? "bound" : "empty"}`}><span>角色母版</span>{boundCharacters.length ? boundCharacters.map((character) => { const selectedStage = stageForShotCharacter(shot, character); return <div className="shot-character-binding" key={character.id}><img src={character.masterImage} alt="" /><b>{character.name}</b><small>身份母版已强制绑定 · {characterStageLabel(selectedStage)}</small>{(character.stages || []).length > 1 && <label className="shot-stage-switch"><span>手动选择年龄阶段</span><select aria-label={`镜头 ${index + 1} ${character.name}年龄阶段`} value={selectedStage} disabled={busy} onChange={(event) => updateShotCharacterStage(shot, character, event.target.value as CharacterStage)}>{(character.stages || []).map((stage) => <option key={stage} value={stage}>{characterStageLabel(stage)}</option>)}</select></label>}</div>; }) : referencedCharacters.length ? <p>已检测到 {referencedCharacters.map((character) => character.name).join("、")}，必须先在角色页生成或导入身份母版；缺少母版时系统会阻止生成</p> : <p>本镜头未检测到需要出镜的固定角色</p>}</div>; })()}
                    <div className={`shot-character-selector ${shot.characterSelectionMode === "manual" ? "manual" : "auto"}`}>
                      <div><span>手动选择出镜角色</span><small>{shot.characterSelectionMode === "manual" ? "当前使用你的选择；自动识别不会覆盖" : "当前按文稿自动识别；选中或取消任一角色即可改为手动"}</small>{shot.characterSelectionMode === "manual" && <button disabled={busy} onClick={() => restoreAutomaticShotCharacters(shot)}>恢复自动识别</button>}</div>
                      <div className="shot-character-options">{activeCharacters.map((character) => <label key={character.id} className={shot.characterIds?.includes(character.id) ? "selected" : ""}><input type="checkbox" checked={Boolean(shot.characterIds?.includes(character.id))} disabled={busy} onChange={(event) => setShotCharacterSelection(shot, character.id, event.target.checked)} /><span>{character.masterImage ? <img src={character.masterImage} alt="" /> : <i>{character.name.slice(0, 1)}</i>}<b>{character.name}</b><small>{character.masterImage ? "母版已绑定" : "缺少母版"}</small></span></label>)}<button className="add-shot-character-option" disabled={busy || !activeCharacters.length} onClick={() => openShotCharacterLibrary(shot)}>＋ 从角色库添加</button>{!activeCharacters.length && <button onClick={() => setActiveStep(2)}>角色库为空，去角色页添加</button>}</div>
                    </div>
                  </div>
                  <div className="shot-wide-editors">
                    <div className="prompt-editor"><div><span>✦ 图片生成提示词</span><small>可直接修改 · 已包含人物表情与真实情境</small><button className="ai-optimize-prompt" disabled={busy || Boolean(optimizingPromptShotId)} onClick={() => void optimizeShotImagePrompt(shot)}>{optimizingPromptShotId === `${shot.id}:image` ? "AI 优化中…" : "AI 优化图片提示词"}</button><button disabled={busy || Boolean(optimizingPromptShotId)} onClick={() => restoreShotImagePrompt(shot)}>恢复 AI 提示词</button></div><textarea aria-label={`镜头 ${index + 1} 图片生成提示词`} value={shot.imagePrompt} disabled={busy || optimizingPromptShotId === `${shot.id}:image`} onChange={(event) => updateShotImagePrompt(shot, event.target.value)} /></div>
                    <div className="prompt-editor video-prompt-editor"><div><span>▶ 视频生成提示词</span><small>AI 按 {providers.video} · {activeVideoPromptModel() || "当前工作流"} 规范生成 · 可编辑 · 直接提交</small><button className="ai-optimize-prompt" disabled={busy || Boolean(optimizingPromptShotId)} onClick={() => void optimizeShotVideoPrompt(shot)}>{optimizingPromptShotId === `${shot.id}:video` ? "AI 优化中…" : "AI 优化视频提示词"}</button><button disabled={busy || Boolean(optimizingPromptShotId)} onClick={() => restoreShotVideoPrompt(shot)}>恢复视频提示词</button></div><textarea aria-label={`镜头 ${index + 1} 视频生成提示词`} value={shot.videoPrompt} disabled={busy || optimizingPromptShotId === `${shot.id}:video`} onChange={(event) => updateShotVideoPrompt(shot, event.target.value)} /></div>
                    <div className="shot-actions"><button className="split-shot-button" disabled={busy} onClick={() => openManualShotSplit(shot)}>拆成两个镜头</button><button onClick={() => updateShot(shot.id, { variant: shot.variant + 1 })}>换个构图</button><button className={shot.approved ? "approved-button" : "confirm-button"} onClick={() => updateShot(shot.id, { approved: !shot.approved })}>{shot.approved ? "✓ 已确认" : "确认镜头"}</button></div>
                  </div>
                </article>
              ))}
            </div>
            <div className="sticky-next"><span>{approvedCount}/{shots.length} 个镜头已确认</span><button disabled={approvedCount < shots.length} onClick={() => setActiveStep(4)}>{approvedCount < shots.length ? "请先确认全部镜头" : "进入画面生成　→"}</button></div>
          </>
        )}

        {activeStep === 4 && (
          <>
            <div className="workspace-heading"><div><StageLabel step={4} /><h1>把分镜变成会呼吸的画面</h1><p>先生成静帧并确认角色一致性，再用批准的图片生成视频，能显著减少返工。</p></div><div className="generation-summary"><span><b>{imageCount}</b>/{shots.length} 图片</span><span><b>{videoCount}</b>/{shots.length} 视频</span></div></div>
            <div className="generation-toolbar"><div><span className="provider-pill">图片 · {providers.image}</span><span className="provider-pill">视频 · {providers.video}</span><label className="video-image-role"><span>分镜图用途</span><select aria-label="Seedance 分镜图用途" value={videoImageRole} disabled={busy} onChange={(event) => { if (allowPaidInputChange("video-reference-mode-change")) setVideoImageRole(event.target.value === "first_frame" ? "first_frame" : "reference_image"); }}><option value="reference_image">参考图驱动（推荐）</option><option value="first_frame">严格首帧</option></select><small>{providers.video === "本地 ComfyUI" ? "Wan 2.2 会把分镜图作为图生视频起始参考" : videoImageRole === "reference_image" ? "参考人物与风格，不要求第一帧相同" : "视频必须从分镜图开始"}</small></label><small id="character-master-generation-block" className="queue-state-legend" aria-label="镜头任务可能状态">{missingApprovedCharacterReferences.length ? `生成前还需补充身份母版：${missingApprovedCharacterReferences.map((character) => character.name).join("、")}。你仍可点击生成按钮，系统会带你前往角色页。` : queueStateLegend.join(" · ")}</small></div><div>{busy && <button className="cancel-queue-button" aria-label="取消尚未提交镜头并停止当前本地轮询" onClick={() => void cancelQueuedGeneration()}>停止本地队列与当前任务</button>}{missingApprovedCharacterReferences.length > 0 && <button className="cancel-queue-button" onClick={() => setActiveStep(2)}>去生成{missingApprovedCharacterReferences.map((character) => character.name).join("、")}母版</button>}<button className="ghost-button" aria-describedby={missingApprovedCharacterReferences.length ? "character-master-generation-block" : undefined} disabled={busy} onClick={() => void generateAssets("image")}>生成全部图片</button><button className="heading-action" aria-describedby={missingApprovedCharacterReferences.length ? "character-master-generation-block" : undefined} disabled={busy || imageCount < shots.length} onClick={() => void generateAssets("video")}>生成全部视频</button></div></div>
            <div className="generation-grid">
              {shots.map((shot, index) => (
                <article className="generation-card" key={shot.id}>
                  <SceneArt shot={shot} className={ratio === "9:16" ? "ratio-portrait-media" : "ratio-landscape-media"} />
                  <div className="generation-card-body"><div className="generation-card-title"><b>镜头 {String(index + 1).padStart(2, "0")}</b><span>{shot.duration} 秒</span></div><p>{shot.visual}</p><div className={`generation-character-status ${boundCharactersForShot(shot).length ? "ready" : "none"}`}>{boundCharactersForShot(shot).length ? `✓ 图片请求将同时带入：${boundCharactersForShot(shot).map((character) => character.name).join("、")}；视频继承合成后的分镜图并锁定全部身份` : referencedCharactersForShot(shot).length ? `已检测到 ${referencedCharactersForShot(shot).map((character) => character.name).join("、")}，点击生成时会先带你补充身份母版` : "本镜头无需角色母版"}</div><div className="asset-states" aria-live="polite"><span className={shot.imageState}>图片 · {assetStateLabel(shot.imageState)}</span><span className={shot.videoState}>视频 · {assetStateLabel(shot.videoState)}{shot.videoTaskId && shot.videoState !== "ready" ? " · 已有任务 ID，只恢复原任务" : ""}{shot.videoSubmissionRisk ? " · 未知受理风险，普通重试已锁定" : ""}</span></div>{shot.error && <p className="shot-error" role="alert">{shot.error}</p>}<div className="generation-actions"><button disabled={busy || ["submitting", "generating", "downloading"].includes(shot.imageState)} onClick={() => void generateAssets("image", shot.id)}>{shot.imageState === "error" || shot.imageState === "canceled" ? "单独重试图片" : shot.imageState === "ready" ? "明确重做图片" : "生成图片"}</button><button disabled={busy || shot.imageState !== "ready" || (["submitting", "generating", "downloading"].includes(shot.videoState) && !shot.videoTaskId)} onClick={() => void generateAssets("video", shot.id)}>{shot.videoTaskId && shot.videoState !== "ready" ? "继续轮询原任务" : shot.videoState === "error" || shot.videoState === "canceled" ? "单独重试视频" : shot.videoState === "ready" ? "明确重做视频" : "生成视频"}</button>{shot.videoState !== "ready" && !shot.videoSubmissionRisk && <button className="cancel-queue-button" onClick={() => void stopShotGeneration(shot)}>{shot.videoTaskProvider === "本地 ComfyUI" && shot.videoTaskId ? "中断本地生成" : shot.videoTaskId ? "停止本地轮询" : "停止本地排队"}</button>}{(shot.videoTaskId || shot.videoSubmissionRisk) && shot.videoTaskProvider !== "本地 ComfyUI" && shot.videoState === "error" && <button className="cancel-queue-button" disabled={busy} onClick={() => setBlockedPaidTask({ shotId: shot.id, provider: shot.videoTaskProvider, status: shot.videoState, taskId: shot.videoTaskId, reason: shot.error || "视频任务仍未解决" })}>处理旧任务 / 只解除本机锁</button>}{(shot.videoTaskId || shot.videoSubmissionRisk) && shot.videoTaskProvider !== "本地 ComfyUI" && shot.videoState === "error" && <button className="resubmit-task-button" aria-label="付费重新提交新任务（放弃旧记录）" disabled={busy} onClick={() => restartVideoTask(shot)}>付费重新提交新任务</button>}</div>{shot.videoTaskId && shot.videoState === "canceled" && shot.videoTaskProvider !== "本地 ComfyUI" && <small className="local-stop-warning">仅停止本地轮询，远端任务可能继续并计费；任务 ID 与服务商记录均已保留。</small>}</div>
                </article>
              ))}
            </div>
            <div className="sticky-next"><span>{busy ? "正在处理生成队列，请稍候…" : `${readyVisualCount}/${shots.length} 个画面已就绪 · ${animatedImageCount} 个将使用 100%→103% 图片推近`}</span><button disabled={readyVisualCount < shots.length} onClick={() => setActiveStep(5)}>{readyVisualCount < shots.length ? "等待全部画面" : "打开时间轴　→"}</button></div>
          </>
        )}

        {activeStep === 5 && (
          <>
            <div className="workspace-heading timeline-heading"><div><StageLabel step={5} /><h1>最后，把节奏交还给你</h1><p>镜头已按解说时间自动排列。生成配音、替换背景音乐、检查字幕，然后导出完整 MP4。</p></div><div className="heading-export"><button className="heading-action" disabled={Boolean(exportBlockReason)} aria-describedby="export-disabled-reason" onClick={openExport}>导出设置　↗</button>{exportBlockReason && <small id="export-disabled-reason">{exportBlockReason}，暂不能导出成片</small>}</div></div>
            <div className="preview-layout">
              <section className="player-panel">
                <div ref={playerFrame} className={`player-frame ${ratio === "9:16" ? "portrait-player" : ""}`}>
                  {currentShot ? <SceneArt shot={{ ...currentShot, imageState: "ready" }} playhead={playhead} playing={playing} /> : <div className="empty-player">暂无镜头</div>}
                  {currentShot && captionsVisible && <div className="player-caption">{currentShot.narration}</div>}
                </div>
                <audio ref={voiceAudio} src={voiceUrl} onTimeUpdate={(event) => setPlayhead(Math.min(totalDuration, event.currentTarget.currentTime))} onEnded={() => { setPlaying(false); setPlayhead(totalDuration); }} />
                <audio ref={musicAudio} src={musicUrl} loop />
                <div className="player-controls"><button onClick={() => seekTimeline(0)}>↶</button><button className="play-button" onClick={toggleTimelinePlayback} aria-label={playing ? "暂停时间轴" : "播放时间轴"}>{playing ? "Ⅱ" : "▶"}</button><span>{formatTime(playhead)} / {formatTime(totalDuration)}</span><div className="player-spacer" /><button className={captionsVisible ? "active" : ""} onClick={() => setCaptionsVisible(!captionsVisible)}>字幕</button><button className={muted ? "active" : ""} onClick={() => setMuted(!muted)}>{muted ? "静音" : "音量"}</button><button onClick={() => void playerFrame.current?.requestFullscreen()}>全屏</button></div>
              </section>
              <aside className="review-panel"><div className="brief-heading"><span className="spark">✓</span><div><strong>成片检查</strong><small>导出前确认关键项目</small></div></div><ul className="review-list"><li className={voiceTimelineAligned ? "done" : "warn"}><span>{voiceTimelineAligned ? "✓" : "!"}</span><div><b>解说文稿</b><small>{script.length} 字，{voiceTimelineAligned ? "配音、字幕与画面已按真实音频时长对齐" : "等待配音后重新对齐时间线"}</small></div></li><li className={imageCount === shots.length ? "done" : "warn"}><span>{imageCount === shots.length ? "✓" : "!"}</span><div><b>分镜图片</b><small>{imageCount}/{shots.length} 个镜头已生成</small></div></li><li className={readyVisualCount === shots.length ? "done" : "warn"}><span>{readyVisualCount === shots.length ? "✓" : "!"}</span><div><b>动态画面</b><small>{videoCount} 个原视频 · {animatedImageCount} 个图片轻推近（100%→103%）</small></div></li><li className={voiceUrl && voiceTimelineAligned ? "done" : "warn"}><span>{voiceUrl && voiceTimelineAligned ? "✓" : "!"}</span><div><b>解说配音</b><small>{voiceUrl ? voiceTimelineAligned ? "已生成并与 A1/T1/V1 轨道对齐" : "已生成，但时间轴尚未重新对齐" : "尚未生成，可在下方生成"}</small></div></li><li className={musicUrl ? "done" : "warn"}><span>{musicUrl ? "✓" : "!"}</span><div><b>背景音乐</b><small>{musicUrl ? `${musicName} · 音量 ${musicVolume}%` : "尚未添加，可导出无背景音乐版本"}</small></div></li><li className={!getExportBlockReason({ shots, script, voiceUrl: voiceUrl || "pending" }).includes("字幕") ? "done" : "warn"}><span>{!getExportBlockReason({ shots, script, voiceUrl: voiceUrl || "pending" }).includes("字幕") ? "✓" : "!"}</span><div><b>字幕轨道</b><small>{getExportBlockReason({ shots, script, voiceUrl: voiceUrl || "pending" }).includes("字幕") ? "字幕未完整覆盖原文文稿" : "已按原文完整生成"}</small></div></li></ul><button className="primary-action review-export" onClick={openExport} disabled={Boolean(exportBlockReason)} aria-describedby="export-disabled-reason"><span><b>检查完成，准备导出</b><small>{exportBlockReason || `${ratio} · 1080p · ${formatTime(totalDuration)}`}</small></span><em>↗</em></button></aside>
            </div>
            <section className="voice-panel"><div><span className="spark">♪</span><div><b>解说配音</b><small>{appSettings.mode === "live" ? `${providers.voice} · ${providers.voice === "ElevenLabs" ? appSettings.elevenlabs.voiceModel || "eleven_v3" : appSettings.openai.voiceModel || "已配置模型"}` : "Windows 本地语音 · 无需 API"} · {voiceTimelineAligned ? "声画已对齐" : voiceUrl ? "等待重新对齐" : "尚未生成"}</small></div></div><div className="voice-controls">{appSettings.mode === "live" && providers.voice === "OpenAI Voice" && <label><span>音色</span><select aria-label="配音音色" value={voiceId} onChange={(event) => changeVoiceSelection(event.target.value)}>{voiceOptions.map((voice) => <option key={voice.id} value={voice.id}>{voice.name}</option>)}</select></label>}{appSettings.mode === "live" && providers.voice === "ElevenLabs" && <label><span>ElevenLabs Voice ID</span><input aria-label="ElevenLabs Voice ID" value={appSettings.elevenlabs.voice} onChange={(event) => changeElevenLabsVoiceId(event.target.value)} placeholder="在设置中填写 Voice ID" /></label>}{voiceUrl && <audio controls src={voiceUrl} />}{voiceUrl && !voiceTimelineAligned && voiceProvenance && <button className="voice-align-button" onClick={() => { if (alignVoiceTimeline(voiceProvenance.duration)) { setVoiceState("ready"); setToast("已按现有配音重新对齐字幕与画面"); } }}>重新对齐时间线</button>}<button disabled={voiceState === "generating"} onClick={() => void generateVoice()}>{voiceState === "generating" ? "正在生成…" : voiceState === "ready" ? "重新生成配音" : "生成配音并对齐"}</button></div></section>
            <input ref={musicInput} className="hidden-input" type="file" accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg,.flac" onChange={importMusic} />
            <section className="music-panel">
              <div><span className="spark music-spark">♫</span><div><b>背景音乐</b><small>{musicUrl ? musicName : "支持 MP3、WAV、M4A、AAC、OGG 和 FLAC"}</small></div></div>
              {musicUrl && <audio controls src={musicUrl} />}
              <label className="music-volume"><span>音乐音量</span><input type="range" min="0" max="100" value={musicVolume} onChange={(event) => setMusicVolume(Number(event.target.value))} /><b>{musicVolume}%</b></label>
              <div className="music-actions"><button onClick={chooseMusic}>{musicUrl ? "替换音乐" : "添加音乐"}</button>{musicUrl && <button className="remove-music" onClick={removeMusic}>移除</button>}</div>
            </section>
            <section className="timeline-panel">
              <div className="timeline-toolbar"><div><button type="button" aria-label="放大时间轴" title="放大时间轴" onClick={() => changeTimelineZoom(10)}>＋</button><button type="button" aria-label="缩小时间轴" title="缩小时间轴" onClick={() => changeTimelineZoom(-10)}>－</button><span>{timelineZoom}%</span><span className="timeline-shortcut-hint">鼠标滚轮缩放 · 空格播放/暂停</span></div><div><button className={snapping ? "active" : ""} onClick={() => setSnapping(!snapping)}>自动吸附 {snapping ? "✓" : ""}</button></div></div>
              <div ref={timelineViewport} className="timeline-scroll-viewport" onWheel={zoomTimelineWithWheel} aria-label="可用鼠标滚轮缩放的时间轴">
                <div ref={timelineContent} className="timeline-content" style={{ width: `${timelineZoom}%` }}>
                  <div className="timeline-ruler"><span>00:00</span><span>{formatTime(totalDuration * .25)}</span><span>{formatTime(totalDuration * .5)}</span><span>{formatTime(totalDuration * .75)}</span><span>{formatTime(totalDuration)}</span></div>
                  <div className="timeline-body">
                    <div className="track-labels"><div><b>画面</b><small>V1</small></div><div><b>解说</b><small>A1</small></div><div><b>字幕</b><small>T1</small></div><div><b>音乐</b><small>A2</small></div></div>
                    <div className="tracks" onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); seekTimeline(((event.clientX - rect.left) / rect.width) * totalDuration); }} onKeyDown={(event) => { if (event.key === "ArrowLeft") seekTimeline(playhead - 1); if (event.key === "ArrowRight") seekTimeline(playhead + 1); }} role="slider" aria-label="时间轴播放位置" aria-valuemin={0} aria-valuemax={totalDuration} aria-valuenow={playhead} tabIndex={0}>
                      <div className="playhead" style={{ left: `${(playhead / totalDuration) * 100}%` }}><i /></div>
                      <div className="video-track">{shots.map((shot, index) => <div className={`timeline-clip clip-${shot.variant % 6}`} style={{ width: `${(shot.duration / totalDuration) * 100}%` }} key={shot.id}><span>{String(index + 1).padStart(2, "0")}</span><small>{shot.duration}s</small></div>)}</div>
                      <div className="audio-track"><div className="waveform">{Array.from({ length: 92 }).map((_, index) => <i style={{ height: `${18 + ((index * 17) % 64)}%` }} key={index} />)}</div></div>
                      <div className="subtitle-track">{shots.map((shot) => <div style={{ width: `${(shot.duration / totalDuration) * 100}%` }} key={shot.id}>{shot.narration.slice(0, 8)}</div>)}</div>
                      <div className={`music-track ${musicUrl ? "ready" : "empty"}`}><button type="button" onClick={(event) => { event.stopPropagation(); void chooseMusic(); }}><span>♫　{musicUrl ? musicName : "点击添加背景音乐"}</span><small>{musicUrl ? `音量 ${musicVolume}% · 点击替换` : "导出时不添加背景音乐"}</small></button></div>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          </>
        )}
      </section>

      {styleOpen && <div className="modal-backdrop" onMouseDown={() => setStyleOpen(false)}>
        <section className="modal style-modal" onMouseDown={(event) => event.stopPropagation()}>
          <button className="modal-close" onClick={() => setStyleOpen(false)}>×</button>
          <span className="eyebrow">GLOBAL VIDEO STYLE · V3</span>
          <h2>统一整条视频的视觉语言</h2>
          <p className="modal-intro">风格会同时写入角色、分镜图片和视频提示词。已经生成素材时，切换风格会提示你重新生成。</p>
          <div className="style-picker-grid">{videoStyles.filter((option) => option.name !== "自定义风格").map((option) => <button key={option.name} className={style === option.name ? "selected" : ""} onClick={() => applyGlobalStyle(option.name)}><span className={`style-preview ${option.tone}`} /><span><b>{option.name}</b><small>{option.detail}</small></span><em>{style === option.name ? "✓" : ""}</em></button>)}</div>
          <div className={`custom-style-panel ${style === "自定义风格" ? "selected" : ""}`}>
            <div className="custom-style-heading"><b>自定义风格提示词</b><small>可以手写，也可以导入参考图让 AI 提取色调、光线、材质、构图和镜头语言</small></div>
            <div className="style-reference-tools">
              <input ref={styleReferenceInput} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={importCustomStyleReference} />
              {customStyleReferenceImage ? <div className="style-reference-preview">
                <img src={customStyleReferenceImage} alt="自定义风格参考图预览" />
                <span><b>风格参考图</b><small>仅分析视觉语言，不识别或复用人物身份</small></span>
                <button type="button" aria-label="移除风格参考图" disabled={styleAnalysisBusy} onClick={() => setCustomStyleReferenceImage("")}>移除</button>
              </div> : <button type="button" className="style-reference-upload" onClick={() => styleReferenceInput.current?.click()}><span>＋</span> 导入风格参考图</button>}
              <button type="button" className="style-reference-analyze" disabled={!customStyleReferenceImage || styleAnalysisBusy || busy} onClick={() => void analyzeCustomStyleReference()}>{styleAnalysisBusy ? "AI 正在分析…" : "AI 分析参考图"}</button>
              <small className="style-reference-note">支持 PNG、JPEG、WebP，最大 12 MB。AI 只提取可复用的视觉风格，结果会先写入下方文本框，由你检查后应用。</small>
            </div>
            <textarea aria-label="自定义全片风格" value={customStyle} onChange={(event) => { if (allowPaidInputChange("style-change")) setCustomStyle(event.target.value); }} placeholder="例如：低饱和青绿色调，柔和侧逆光，35mm 胶片颗粒，克制构图，缓慢镜头语言……" />
            <button className="apply-custom-style" disabled={!customStyle.trim() || styleAnalysisBusy} onClick={() => applyGlobalStyle("自定义风格", customStyle)}>应用自定义风格</button>
          </div>
          <div className="style-scope"><span>统一影响</span><b>角色母版</b><b>分镜图片</b><b>视频运镜</b><b>光线色调</b></div>
        </section>
      </div>}

      {characterPreview && <div className="modal-backdrop" onMouseDown={() => setCharacterPreview(null)}><section className="modal character-preview-modal" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" onClick={() => setCharacterPreview(null)}>×</button><span className="eyebrow">CHARACTER PREVIEW</span><h2>{characterPreview.name} · 角色图</h2><div className="character-preview-image"><img src={characterPreview.src} alt={`${characterPreview.name}角色大图预览`} /><span>{providers.image} · 演示预览</span></div><div className="preview-prompt"><b>生成提示词</b><p>{characterPreview.prompt}</p><button onClick={() => copyCharacterPrompt(characterPreview.prompt, characterPreview.name)}>复制提示词</button></div></section></div>}

      {shotSplitDraft && (() => { const target = shots.find((shot) => shot.id === shotSplitDraft.shotId); const durations = target ? allocateSplitDurations(target.duration, shotSplitDraft.first, shotSplitDraft.second) : [0, 0]; return <div className="modal-backdrop" onMouseDown={() => setShotSplitDraft(null)}><section className="modal shot-split-modal" role="dialog" aria-modal="true" aria-labelledby="shot-split-title" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" aria-label="取消拆分镜头" onClick={() => setShotSplitDraft(null)}>×</button><span className="eyebrow">MANUAL SHOT SPLIT</span><h2 id="shot-split-title">把这个分镜拆成两个镜头</h2><p className="modal-intro">把原文分别放进镜头 A 和镜头 B。不能在这里增删文案；拆分后可分别修改画面描述、角色、景别和两种生成提示词。</p><div className="shot-split-grid"><label><span>镜头 A · 约 {durations[0]} 秒</span><textarea aria-label="拆分后的镜头 A 文案" value={shotSplitDraft.first} onChange={(event) => setShotSplitDraft({ ...shotSplitDraft, first: event.target.value, error: "" })} /></label><div className="shot-split-arrow">→</div><label><span>镜头 B · 约 {durations[1]} 秒</span><textarea aria-label="拆分后的镜头 B 文案" value={shotSplitDraft.second} onChange={(event) => setShotSplitDraft({ ...shotSplitDraft, second: event.target.value, error: "" })} /></label></div>{shotSplitDraft.error && <p className="shot-split-error" role="alert">{shotSplitDraft.error}</p>}<div className="shot-split-note"><b>拆分后会自动完成</b><span>保持总时长不变 · 重新排列时间轴 · 第二镜头采用不同景别 · 继承角色母版和当前视频模型规范</span></div><div className="notice-actions"><button onClick={() => setShotSplitDraft(null)}>取消</button><button className="primary-inline" onClick={() => void confirmManualShotSplit()}>确认拆成两个镜头</button></div></section></div>; })()}

      {shotCharacterLibraryDraft && <div className="modal-backdrop" onMouseDown={() => setShotCharacterLibraryDraft(null)}><section className="modal shot-character-library-modal" role="dialog" aria-modal="true" aria-labelledby="shot-character-library-title" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" aria-label="关闭角色库" onClick={() => setShotCharacterLibraryDraft(null)}>×</button><span className="eyebrow">CAST LIBRARY</span><h2 id="shot-character-library-title">从角色库选择出镜角色</h2><p className="modal-intro">这里不会新建角色。勾选已经在角色页建立的角色，可一次加入多个（单镜头最多 4 个）；图片生成会同时提交每个角色的身份母版，视频从合成分镜图继承全部人物。</p><div className="shot-character-library-list">{activeCharacters.map((character) => { const selected = shotCharacterLibraryDraft.selectedIds.includes(character.id); const limitReached = !selected && shotCharacterLibraryDraft.selectedIds.length >= 4; return <label key={character.id} className={`${selected ? "selected" : ""} ${limitReached ? "disabled" : ""}`}><input type="checkbox" checked={selected} disabled={limitReached} onChange={(event) => setShotCharacterLibraryDraft({ ...shotCharacterLibraryDraft, selectedIds: event.target.checked ? [...new Set([...shotCharacterLibraryDraft.selectedIds, character.id])] : shotCharacterLibraryDraft.selectedIds.filter((id) => id !== character.id), error: "" })} />{character.masterImage ? <img src={character.masterImage} alt="" /> : <i>{character.name.slice(0, 1)}</i>}<span><b>{character.name}</b><small>{character.masterImage ? "身份母版已绑定" : "尚未绑定身份母版"}</small></span><em>{selected ? "✓ 已选择" : limitReached ? "已达上限" : "选择"}</em></label>; })}</div>{shotCharacterLibraryDraft.error && <p className="shot-split-error" role="alert">{shotCharacterLibraryDraft.error}</p>}<div className="notice-actions"><button onClick={() => setShotCharacterLibraryDraft(null)}>取消</button><button className="primary-inline" onClick={confirmShotCharacterLibrary}>应用到当前镜头</button></div></section></div>}

      {generationNotice && <div className="modal-backdrop"><section className="modal generation-notice-modal" role="dialog" aria-modal="true" aria-labelledby="generation-notice-title" aria-describedby="generation-cost-uncertain"><button className="modal-close" aria-label="关闭生成前确认" onClick={() => { pendingGeneration.current = null; setGenerationNotice(null); }}>×</button><span className="eyebrow">COST & DATA CHECK</span><h2 id="generation-notice-title">生成前确认</h2><p id="generation-cost-uncertain" className="modal-intro">暂时无法准确计算费用，请以服务商最终账单为准。</p><dl className="generation-notice-list"><div><dt>服务商</dt><dd>{generationNotice.provider}</dd></div><div><dt>模型</dt><dd>{generationNotice.model}</dd></div><div><dt>生成项</dt><dd>{generationNotice.title} · {generationNotice.itemCount} 项</dd></div><div><dt>将上传</dt><dd>{generationNotice.uploads}</dd></div><div><dt>取消规则</dt><dd>{generationNotice.cancellation} 提交后通常无法取消。</dd></div><div><dt>失败计费</dt><dd>失败任务是否计费由服务商决定；{generationNotice.failureBilling}</dd></div></dl><label className="notice-consent"><input type="checkbox" checked={generationAcknowledged} onChange={(event) => setGenerationAcknowledged(event.target.checked)} /><span>我已了解上传范围与服务商计费规则</span></label><div className="notice-actions"><button ref={generationBackButton} onClick={() => { pendingGeneration.current = null; setGenerationNotice(null); }}>返回修改</button><button className="primary-inline" disabled={!generationAcknowledged} onClick={confirmGeneration}>确认生成</button></div></section></div>}

      {blockedPaidTask && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setBlockedPaidTask(null); }}><section className="modal paid-task-resolution-modal" role="dialog" aria-modal="true" aria-labelledby="paid-task-resolution-title"><button className="modal-close" aria-label="暂时关闭任务处理窗口" onClick={() => setBlockedPaidTask(null)}>×</button><span className="eyebrow">PAID TASK SAFETY</span><h2 id="paid-task-resolution-title">这个视频任务还没有结束</h2><p className="modal-intro">镜头 <b>{blockedPaidTask.shotId.replace("shot-", "")}</b> 的 {blockedPaidTask.provider || "视频服务商"} 任务仍处于“{blockedPaidTask.status}”状态，所以修改角色、分镜或首图会被暂时锁定。</p><div className="paid-task-options"><section><b>继续查询原任务</b><p>使用原任务 ID 继续查询，不会再次提交，也不会因为查询而新增一次生成请求。</p>{blockedPaidTask.taskId ? <code>{blockedPaidTask.taskId}</code> : <small>这次请求没有取得可靠任务 ID，无法继续查询。</small>}</section><section className="danger"><b>放弃等待并解除锁定</b><p>保留审计记录，但让你立即继续修改项目。此操作不会向 Seedance 发送远端取消请求，远端任务仍可能继续和计费。</p></section></div><div className="paid-task-actions"><button onClick={() => setBlockedPaidTask(null)}>暂不处理</button>{blockedPaidTask.taskId && <button onClick={continueBlockedPaidTask}>继续查询原任务</button>}<button className="abandon-task-button" onClick={() => void abandonBlockedPaidTask()}>放弃等待并解除锁定</button></div></section></div>}

      {dataNoticeOpen && <div className="modal-backdrop"><section className="modal data-notice-modal" role="dialog" aria-modal="true" aria-labelledby="data-notice-title"><button ref={dataNoticeCloseButton} className="modal-close" aria-label="关闭数据与费用说明" onClick={() => setDataNoticeOpen(false)}>×</button><span className="eyebrow">DATA & BILLING</span><h2 id="data-notice-title">数据与费用说明</h2><div className="data-boundaries"><section><b>项目草稿位置</b><p>项目草稿保存在当前 Windows 用户的应用本地存储中，位于应用数据目录内：<code>{storageInfo?.userDataPath || "仅安装版运行时显示实际路径"}</code>。草稿仍沿用原有数据格式。</p></section><section><b>本地媒体缓存</b><p>导入或生成的参考图、视频、配音和音乐副本位于：<code>{storageInfo?.mediaPath || "应用数据目录下的 media 文件夹"}</code>。</p></section><section><b>付费任务记录</b><p>无密钥 journal 位于：<code>{storageInfo?.paidTaskJournalFile || "应用数据目录下的 paid-video-tasks.json"}</code>。它只记录项目/镜头标识、服务商、状态、任务 ID、提交时间和请求指纹，不保存提示词、API Key 或参考图内容。本地 ComfyUI 任务不写入付费 journal。</p></section><section><b>何时上传</b><p>演示模式不提交真实生成。Seedance 等云端服务只在你通过生成前确认后上传确认页列出的内容；选择“本地 ComfyUI”时，参考图、提示词和结果仅在本机的幕境与 ComfyUI 之间传递。导出 MP4 始终在本机完成。</p></section><section><b>API Key 保存边界</b><p>桌面版使用 Electron 的 Windows 加密存储，把设置写入 <code>{storageInfo?.settingsFile || "provider-settings.bin"}</code>。读取设置时，主进程只向页面返回是否已保存密钥，不返回旧明文；仅当你本次主动输入新密钥时，页面会短暂持有该输入。发起服务商请求时只由主进程解密使用。API Key 不写入 .story 制作包。</p></section><section><b>主动清理与删除关系</b><p>当前版本没有一键缓存清理或删除项目按钮。关闭幕境后可管理上述本地媒体缓存；删除缓存会让项目中的对应素材失效。清空文稿或分镜不会删除缓存、服务商副本、付费任务 journal 或已经导出的 MP4，删除导出的 MP4 也不会清除项目草稿。</p></section><section><b>费用由谁收取</b><p>云端真实生成费用由你配置的服务商直接收取，幕境不代收；本地 ComfyUI 没有服务商单次生成费，但会占用本机显卡、电力与磁盘。云端失败任务和取消后的计费以服务商最终账单与规则为准。</p></section></div><button className="primary-inline modal-save" onClick={() => setDataNoticeOpen(false)}>我知道了</button></section></div>}

      {settingsOpen && <div className="modal-backdrop" onMouseDown={() => setSettingsOpen(false)}><section className="modal api-settings-modal" onMouseDown={(event) => event.stopPropagation()}>
        <button className="modal-close" onClick={() => setSettingsOpen(false)}>×</button><span className="eyebrow">MODEL ROUTING</span><h2>模型与 API 设置</h2><p className="modal-intro">在这里填写 API。密钥只保存在这台电脑的 Windows 加密存储中，不会写进项目文件。</p>
        <div className="mode-switch"><button className={appSettings.mode === "demo" ? "selected" : ""} onClick={() => setAppSettings({ ...appSettings, mode: "demo" })}><b>演示模式</b><small>无需密钥，完整体验流程</small></button><button className={appSettings.mode === "live" ? "selected" : ""} onClick={() => setAppSettings({ ...appSettings, mode: "live" })}><b>真实模型</b><small>使用你的 API 生成素材</small></button></div>
        <div className="provider-settings">{([['storyboard','分镜设计',['OpenAI','自定义兼容服务']],['image','图片生成',['OpenAI Image','Seedream']],['video','视频生成',['Seedance','本地 ComfyUI']],['voice','解说配音',['OpenAI Voice','ElevenLabs','火山语音']]] as const).map(([key,label,options]) => <label key={key}><span>{label}</span><select value={providers[key]} onChange={(event) => changeProviderSelection(key, event.target.value)}>{options.map((option) => <option key={option}>{option}</option>)}</select><small>{key === "video" && providers.video === "本地 ComfyUI" ? "本机运行 · 不上传云端" : appSettings.mode === "live" ? "真实" : "演示"}</small></label>)}</div>
        <section className="api-provider-card"><div className="api-provider-heading"><div><b>OpenAI</b><small>分镜、GPT Image 和语音</small></div><span>{appSettings.openai.clearApiKey ? "保存后清除" : appSettings.openai.apiKey ? "已输入新密钥" : appSettings.openai.hasKey ? "已保存" : "未保存"}</span></div><div className="api-field full"><label>API Key</label><input type="password" autoComplete="off" value={appSettings.openai.apiKey} onChange={(event) => updateProviderConfig("openai", "apiKey", event.target.value)} placeholder={appSettings.openai.hasKey ? "已保存；留空不会覆盖旧密钥" : "sk-…"} />{appSettings.openai.hasKey && !appSettings.openai.clearApiKey && <button type="button" onClick={() => clearProviderKey("openai")}>明确清除已保存密钥</button>}</div><div className="api-field full"><label>服务地址</label><input value={appSettings.openai.baseUrl} onChange={(event) => updateProviderConfig("openai", "baseUrl", event.target.value)} placeholder="https://api.openai.com/v1" /></div><div className="api-model-grid"><div className="api-field"><label>分镜模型</label><input value={appSettings.openai.storyboardModel} onChange={(event) => updateProviderConfig("openai", "storyboardModel", event.target.value)} /></div><div className="api-field"><label>图片模型</label><input value={appSettings.openai.imageModel} onChange={(event) => updateProviderConfig("openai", "imageModel", event.target.value)} /></div><div className="api-field"><label>配音模型</label><input value={appSettings.openai.voiceModel} onChange={(event) => updateProviderConfig("openai", "voiceModel", event.target.value)} /></div></div><div className="api-actions"><button disabled={testingConnection || (!appSettings.openai.apiKey && !appSettings.openai.hasKey) || appSettings.openai.clearApiKey} onClick={() => void testApiConnection("openai")}>{testingConnection ? "正在测试…" : "测试 OpenAI 连接"}</button></div></section>
        <section className="api-provider-card elevenlabs-card"><div className="api-provider-heading"><div><b>ElevenLabs</b><small>Eleven v3 多语言解说配音与自定义音色</small></div><span>{appSettings.elevenlabs.clearApiKey ? "保存后清除" : appSettings.elevenlabs.apiKey ? "已输入新密钥" : appSettings.elevenlabs.hasKey ? "已保存" : "未保存"}</span></div><div className="api-field full"><label>ElevenLabs API Key</label><input type="password" autoComplete="off" value={appSettings.elevenlabs.apiKey} onChange={(event) => updateProviderConfig("elevenlabs", "apiKey", event.target.value)} placeholder={appSettings.elevenlabs.hasKey ? "已保存；留空不会覆盖旧密钥" : "粘贴 ElevenLabs API Keys 页面新建的密钥"} /><small>当前密钥必须具备 Text to Speech 和 Voices 读取权限；请勿填写账号密码。</small>{appSettings.elevenlabs.hasKey && !appSettings.elevenlabs.clearApiKey && <button type="button" onClick={() => clearProviderKey("elevenlabs")}>明确清除已保存密钥</button>}</div><div className="api-field full"><label>服务地址</label><input value={appSettings.elevenlabs.baseUrl} onChange={(event) => updateProviderConfig("elevenlabs", "baseUrl", event.target.value)} placeholder="https://api.elevenlabs.io/v1" /></div><div className="api-model-grid"><div className="api-field"><label>配音模型</label><input value={appSettings.elevenlabs.voiceModel} onChange={(event) => updateProviderConfig("elevenlabs", "voiceModel", event.target.value)} placeholder="eleven_v3" /></div><div className="api-field"><label>Voice ID</label><input value={appSettings.elevenlabs.voice} onChange={(event) => updateProviderConfig("elevenlabs", "voice", event.target.value)} placeholder="例如 JBFqnCBsd6RMkjVDRZzb" /><small>必须填写 Voices 页面中的真实 Voice ID，不是音色名称。</small></div></div><div className="api-actions"><small>测试只读取该音色，不生成音频，不消耗配音字符。</small><button disabled={testingConnection || (!appSettings.elevenlabs.apiKey && !appSettings.elevenlabs.hasKey) || appSettings.elevenlabs.clearApiKey} onClick={() => void testApiConnection("elevenlabs")}>{testingConnection ? "正在测试…" : "测试 ElevenLabs 连接"}</button></div></section>
        <section className="api-provider-card comfyui-card"><div className="api-provider-heading"><div><b>本地 ComfyUI</b><small>Wan 2.2 图生视频 · 素材留在本机 · 无服务商单次生成费</small></div><span>本地服务</span></div>
          <p>幕境只负责提交工作流、显示进度、取消任务和取回视频；不会自动下载几十 GB 的模型。请先启动最新版 ComfyUI。内置工作流需要 <b>Wan 2.2 TI2V-5B</b> 的 UNET、VAE 与 UMT5 文本编码器。</p>
          <div className="api-field full"><label>ComfyUI 服务地址</label><input value={appSettings.comfyui.baseUrl} onChange={(event) => updateProviderConfig("comfyui", "baseUrl", event.target.value)} placeholder="http://127.0.0.1:8188" /><small>目前仅允许连接本机 127.0.0.1、localhost 或 ::1，防止工作流读取被转发到外部设备。</small></div>
          <div className="api-model-grid"><div className="api-field"><label>本地工作流</label><select value={appSettings.comfyui.videoModel} onChange={(event) => updateProviderConfig("comfyui", "videoModel", event.target.value)}><option value="wan2.2-ti2v-5b">内置 Wan 2.2 TI2V-5B</option><option value="custom-workflow">自定义 API 工作流</option></select></div><div className="api-field"><label>帧率</label><select value={appSettings.comfyui.fps} onChange={(event) => updateProviderConfig("comfyui", "fps", event.target.value)}><option value="16">16 fps（更省显存/时间）</option><option value="24">24 fps（推荐）</option></select></div><div className="api-field"><label>采样步数</label><select value={appSettings.comfyui.steps} onChange={(event) => updateProviderConfig("comfyui", "steps", event.target.value)}><option value="20">20（快速）</option><option value="30">30（推荐）</option><option value="40">40（精细）</option></select></div></div>
          <div className="api-field full"><label>自定义 API 工作流</label><input readOnly value={appSettings.comfyui.workflowPath} placeholder="未导入时使用内置 Wan 2.2 工作流" /><div className="api-actions"><button type="button" onClick={() => void chooseComfyUIWorkflow()}>导入 API 工作流 JSON</button>{appSettings.comfyui.workflowPath && <button type="button" onClick={() => { updateProviderConfig("comfyui", "workflowPath", ""); updateProviderConfig("comfyui", "videoModel", "wan2.2-ti2v-5b"); }}>恢复内置工作流</button>}</div><small>普通 ComfyUI 界面工作流不能直接提交；必须在开发者模式中导出“API 格式”。幕境会自动替换参考图、提示词、项目比例、时长、帧率与随机种子。</small></div>
          <div className="api-actions"><small>连接测试会检查显卡信息、工作流所需节点与缺失节点，不会开始生成。</small><button disabled={testingConnection} onClick={() => void testApiConnection("comfyui")}>{testingConnection ? "正在检测本地环境…" : "检测 ComfyUI 与工作流"}</button></div>
        </section>
        <details className="custom-api-card">
          <summary>Seedream / Seedance / 其他兼容服务 · {appSettings.custom.clearApiKey ? "保存后清除密钥" : appSettings.custom.apiKey ? "已输入新密钥" : appSettings.custom.hasKey ? "密钥已保存" : "未保存密钥"}</summary>
          <p>Seedream 与 Seedance 已按火山方舟接口适配。当前稳定公开视频 API 推荐 Seedance 1.5 Pro。Seedance 2.x 等邀测/灰度模型只填写方舟控制台复制的 <b>ep-… 推理接入点 ID</b>，不要根据发布日期手写 Model ID。服务地址留空时使用北京区默认地址。</p>
          <div className="api-field full"><label>API Key</label><input type="password" autoComplete="off" value={appSettings.custom.apiKey} onChange={(event) => updateProviderConfig("custom", "apiKey", event.target.value)} placeholder={appSettings.custom.hasKey ? "已保存；留空不会覆盖旧密钥" : "火山方舟或其他服务商 API Key"} />{appSettings.custom.hasKey && !appSettings.custom.clearApiKey && <button type="button" onClick={() => clearProviderKey("custom")}>明确清除已保存密钥</button>}</div>
          <div className="api-field full"><label>服务地址</label><input value={appSettings.custom.baseUrl} onChange={(event) => updateProviderConfig("custom", "baseUrl", event.target.value)} placeholder="https://ark.cn-beijing.volces.com/api/v3" /></div>
          <div className="api-model-grid">
            <div className="api-field"><label>分镜模型</label><input value={appSettings.custom.storyboardModel} onChange={(event) => updateProviderConfig("custom", "storyboardModel", event.target.value)} placeholder="可选" /></div>
            <div className="api-field"><label>Seedream 模型 ID</label><input value={appSettings.custom.imageModel} onChange={(event) => updateProviderConfig("custom", "imageModel", event.target.value)} placeholder="doubao-seedream-… 或 ep-…" /></div>
            <div className="api-field"><label>Seedance 模型 / Endpoint ID</label><input list="seedance-model-options" value={appSettings.custom.videoModel} onChange={(event) => updateProviderConfig("custom", "videoModel", event.target.value)} placeholder="选择模型，或粘贴 ep-…" /><datalist id="seedance-model-options"><option value="doubao-seedance-2-5-260628" label="Seedance 2.5（需账号已开通）" /><option value="doubao-seedance-2-0-260128" label="Seedance 2.0（需账号已开通）" /><option value="doubao-seedance-1-5-pro-251215" label="Seedance 1.5 Pro" /></datalist><small>Seedance 2.x 支持“参考图驱动”；1.x 图生视频请选择“严格首帧”。</small></div>
            <div className="api-field"><label>配音模型</label><input value={appSettings.custom.voiceModel} onChange={(event) => updateProviderConfig("custom", "voiceModel", event.target.value)} placeholder="兼容服务可选" /></div>
          </div>
          <div className="api-actions"><button disabled={testingConnection || (!appSettings.custom.apiKey && !appSettings.custom.hasKey) || appSettings.custom.clearApiKey || !appSettings.custom.videoModel.trim()} onClick={() => void testApiConnection("custom")}>{testingConnection ? "正在测试…" : "测试 Seedance 连接"}</button></div>
        </details>
        <div className="security-note"><span>⌁</span><p><b>{window.mujingDesktop ? "Windows 加密保存" : "浏览器预览模式"}</b><br />{window.mujingDesktop ? "读取设置只返回“已保存”状态，不把旧密钥发给页面；你本次主动输入的新密钥会在页面中短暂存在，保存后清空。服务商请求仅由主进程解密并发送。" : "请在安装版中填写并使用 API 密钥。"}</p></div><button className="primary-inline modal-save" onClick={saveModelSettings}>保存设置</button>
      </section></div>}

      {exportOpen && <div className="modal-backdrop" onMouseDown={() => !rendering && setExportOpen(false)}><section className="modal export-modal" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" disabled={rendering} onClick={() => setExportOpen(false)}>×</button><span className="eyebrow">EXPORT VIDEO</span><h2>导出你的作品</h2><p className="modal-intro">桌面版会把真实视频与带轻微推近的静态图片、完整解说配音和中文字幕轨道渲染成可直接播放的完整 MP4，同时保留可恢复的项目制作包。</p><div className="export-preview"><div className="export-cover"><span>幕境</span><b>{projectName}</b><small>{shots.length} 个镜头 · {formatTime(totalDuration)}</small></div><div className="export-details"><dl><div><dt>画面比例</dt><dd>{ratio}</dd></div><div><dt>输出规格</dt><dd>1080p</dd></div><div><dt>画面素材</dt><dd>{videoCount} 视频 · {animatedImageCount} 动态图片</dd></div><div><dt>背景音乐</dt><dd>{musicUrl ? `${musicName} · ${musicVolume}%` : "未添加"}</dd></div><div><dt>字幕</dt><dd>完整 MP4 中文字幕轨</dd></div></dl></div></div><div className={`export-notice ${exportBlockReason ? "" : "ready"}`}><b>{exportBlockReason ? "还缺少完整成片素材" : "可以导出完整成片"}</b><span>{exportBlockReason || `已准备 ${videoCount} 个原视频、${animatedImageCount} 个 100%→103% 图片推近镜头、完整解说配音和原文字幕${musicUrl ? "，并添加背景音乐" : "；未添加背景音乐"}。`}</span></div><button className="primary-inline modal-save" disabled={rendering || Boolean(exportBlockReason)} onClick={exportMp4}>{rendering ? "正在渲染视频，请稍候…" : "导出完整 MP4　↗"}</button><form action="/api/export" method="post" onSubmit={() => window.setTimeout(finishExport, 500)}><input type="hidden" name="payload" value={exportPayloadString} /><button className="secondary-export download-link" type="submit" disabled={rendering}>另存 .story 项目制作包　↓</button></form></section></div>}

      {generationProgress && <aside className={`generation-progress-card ${generationProgress.status}`} aria-live="polite" aria-label="生成任务进度">
        <div className="generation-progress-icon">{generationProgress.status === "running" ? <i /> : generationProgress.status === "success" ? "✓" : generationProgress.status === "canceled" ? "–" : "!"}</div>
        <div className="generation-progress-copy"><div><b>{generationProgress.title}</b><span>{generationProgress.status === "running" ? "生成中" : generationProgress.status === "success" ? "已完成" : generationProgress.status === "canceled" ? "已停止" : "生成失败"}</span></div><p>{generationProgress.detail}</p><div className={`generation-progress-track ${generationProgress.total === 1 && generationProgress.status === "running" ? "indeterminate" : ""}`}><i style={generationProgress.total === 1 && generationProgress.status === "running" ? undefined : { width: `${generationProgress.status === "success" ? 100 : Math.round((generationProgress.current / generationProgress.total) * 100)}%` }} /></div>{generationProgress.total > 1 && <small>已完成 {generationProgress.current} / {generationProgress.total}</small>}</div>
        {generationProgress.status !== "running" && <button aria-label="关闭生成进度" onClick={() => setGenerationProgress(null)}>×</button>}
      </aside>}
      {toast && <div className="toast"><span>✓</span>{toast}</div>}
    </main>
  );
}
