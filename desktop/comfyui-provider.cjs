const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { readPaidVideoFirstFrame } = require("./media-input.cjs");
const { probeMediaFile } = require("./media-tools.cjs");

const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_WORKFLOW_BYTES = 2 * 1024 * 1024;
const MAX_VIDEO_BYTES = 1024 * 1024 * 1024;
const BUILTIN_WORKFLOW = path.join(__dirname, "comfyui-workflows", "wan22-ti2v-5b-api.json");

function baseUrl(config) {
  let url;
  try { url = new URL(String(config?.baseUrl || "http://127.0.0.1:8188")); }
  catch { throw new Error("ComfyUI 服务地址无效，应类似 http://127.0.0.1:8188。"); }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) throw new Error("为保护本机文件，本地 ComfyUI 目前只允许 127.0.0.1、localhost 或 ::1。");
  if (url.username || url.password || !["http:", "https:"].includes(url.protocol)) throw new Error("ComfyUI 服务地址不允许包含账号密码，且必须使用 HTTP 或 HTTPS。");
  url.pathname = "/"; url.search = ""; url.hash = "";
  return url.href.replace(/\/$/, "");
}

async function readJson(response, label, maxBytes = MAX_JSON_BYTES) {
  const declared = Number(response.headers?.get?.("content-length") || 0);
  if (declared > maxBytes) throw new Error(`${label}过大，已停止读取。`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`${label}无法读取。`);
  const chunks = []; let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel(); throw new Error(`${label}过大，已停止读取。`); }
      chunks.push(Buffer.from(value));
    }
  } catch (error) { try { await reader.cancel(); } catch { /* The rejected local response is already being discarded. */ } throw error; }
  const buffer = Buffer.concat(chunks, total);
  try { return JSON.parse(buffer.toString("utf8")); }
  catch { throw new Error(`${label}不是有效 JSON。`); }
}

async function request(config, endpoint, init = {}, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 30_000);
  try {
    const response = await (options.fetch || fetch)(`${baseUrl(config)}${endpoint}`, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`ComfyUI 拒绝请求（HTTP ${response.status}）。请查看 ComfyUI 终端中的具体节点错误。`);
    return response;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("连接 ComfyUI 超时；请确认本地服务已启动且没有卡在模型加载。\n");
    if (/fetch failed|ECONNREFUSED|Failed to fetch/i.test(String(error?.message || error))) throw new Error("无法连接本地 ComfyUI。请先启动 ComfyUI，并确认服务地址和端口正确。");
    throw error;
  } finally { clearTimeout(timer); }
}

function readWorkflow(config) {
  const source = String(config?.workflowPath || "").trim() || BUILTIN_WORKFLOW;
  if (path.extname(source).toLowerCase() !== ".json") throw new Error("ComfyUI 工作流必须是 JSON 文件。请从 ComfyUI 导出 API 格式工作流。 ");
  const stat = fs.statSync(source);
  if (!stat.isFile() || stat.size > MAX_WORKFLOW_BYTES) throw new Error("ComfyUI 工作流不存在或超过 2MB。 ");
  const parsed = JSON.parse(fs.readFileSync(source, "utf8"));
  const workflow = parsed?.prompt && typeof parsed.prompt === "object" ? parsed.prompt : parsed;
  if (!workflow || Array.isArray(workflow) || typeof workflow !== "object") throw new Error("ComfyUI 工作流格式无效。 ");
  const nodes = Object.values(workflow);
  if (!nodes.length || nodes.some((node) => !node || typeof node.class_type !== "string" || typeof node.inputs !== "object")) {
    throw new Error("这不是 ComfyUI API 格式工作流。请开启开发者模式后选择“保存（API 格式）”。");
  }
  return JSON.parse(JSON.stringify(workflow));
}

function classTypes(workflow) { return [...new Set(Object.values(workflow).map((node) => node.class_type))]; }

function dimensions(ratio) { return ratio === "9:16" ? { width: 704, height: 1280 } : { width: 1280, height: 704 }; }

function patchedWorkflow(config, payload, uploadedName) {
  const workflow = readWorkflow(config);
  const { width, height } = dimensions(payload?.ratio);
  const fps = Math.max(8, Math.min(60, Number(config?.fps) || 24));
  const steps = Math.max(1, Math.min(100, Number(config?.steps) || 30));
  const frames = Math.max(17, Math.min(241, Math.round((Math.max(1, Number(payload?.duration) || 4) * fps - 1) / 4) * 4 + 1));
  const prompt = String(payload?.prompt || "").trim();
  if (!prompt) throw new Error("本地视频提示词为空。 ");
  let positivePatched = false;
  let imagePatched = false;
  for (const node of Object.values(workflow)) {
    const inputs = node.inputs;
    const title = String(node?._meta?.title || "").toLowerCase();
    if (node.class_type === "LoadImage") { inputs.image = uploadedName; imagePatched = true; }
    if (node.class_type === "CLIPTextEncode" && !/negative|负面/.test(title) && (!positivePatched || /positive|正面/.test(title))) {
      inputs.text = prompt; positivePatched = true;
    }
    if (Object.hasOwn(inputs, "width") && Number.isFinite(Number(inputs.width))) inputs.width = width;
    if (Object.hasOwn(inputs, "height") && Number.isFinite(Number(inputs.height))) inputs.height = height;
    if (Object.hasOwn(inputs, "length") && Number.isFinite(Number(inputs.length))) inputs.length = frames;
    if (node.class_type === "KSampler") { inputs.seed = crypto.randomInt(1, 2_147_483_647); inputs.steps = steps; }
    if (/SaveWEBM|SaveVideo|VHS_VideoCombine/i.test(node.class_type)) {
      if (Object.hasOwn(inputs, "fps")) inputs.fps = fps;
      if (Object.hasOwn(inputs, "frame_rate")) inputs.frame_rate = fps;
      if (Object.hasOwn(inputs, "filename_prefix")) inputs.filename_prefix = `MuJing-${String(payload?.shotId || "shot").replace(/[^a-z0-9_-]/gi, "-")}`;
    }
  }
  if (!positivePatched) throw new Error("工作流缺少 CLIPTextEncode 正面提示词节点。 ");
  if (!imagePatched) throw new Error("工作流缺少 LoadImage 节点，无法使用分镜参考图生成视频。 ");
  return workflow;
}

function modelChoices(objectInfo, classType, inputName) {
  const choices = objectInfo?.[classType]?.input?.required?.[inputName]?.[0];
  return Array.isArray(choices) ? choices.map(String) : null;
}

function missingWorkflowModels(workflow, objectInfo) {
  const checks = [
    ["UNETLoader", "unet_name", "models/diffusion_models"],
    ["CLIPLoader", "clip_name", "models/text_encoders"],
    ["VAELoader", "vae_name", "models/vae"],
    ["CheckpointLoaderSimple", "ckpt_name", "models/checkpoints"],
  ];
  const missing = [];
  for (const node of Object.values(workflow)) {
    const check = checks.find(([classType]) => classType === node.class_type);
    if (!check) continue;
    const [, inputName, folder] = check;
    const configured = String(node.inputs?.[inputName] || "").trim();
    const available = modelChoices(objectInfo, node.class_type, inputName);
    if (configured && available && !available.includes(configured)) missing.push(`${configured}（放入 ComfyUI/${folder}）`);
  }
  return [...new Set(missing)];
}

async function testComfyUIConnection(config, options = {}) {
  const [statsResponse, nodesResponse] = await Promise.all([
    request(config, "/system_stats", { method: "GET" }, options),
    request(config, "/object_info", { method: "GET" }, options),
  ]);
  const stats = await readJson(statsResponse, "ComfyUI 系统信息");
  const objectInfo = await readJson(nodesResponse, "ComfyUI 节点信息");
  const workflow = readWorkflow(config);
  const requiredNodes = classTypes(workflow);
  const missingNodes = requiredNodes.filter((type) => !Object.hasOwn(objectInfo, type));
  const device = Array.isArray(stats?.devices) ? stats.devices[0] : null;
  const vramGb = device?.vram_total ? Math.round((Number(device.vram_total) / 1024 ** 3) * 10) / 10 : null;
  if (missingNodes.length) throw new Error(`ComfyUI 已连接，但工作流缺少节点：${missingNodes.join("、")}。请更新 ComfyUI 或安装工作流所需自定义节点。`);
  const missingModels = missingWorkflowModels(workflow, objectInfo);
  if (missingModels.length) throw new Error(`ComfyUI 已连接，但缺少工作流模型：${missingModels.join("、")}。放好文件后请在 ComfyUI 中刷新模型列表再测试。`);
  return { ok: true, gpuName: String(device?.name || device?.type || "未识别"), vramGb, requiredNodes, missingNodes, missingModels, workflow: config?.workflowPath ? "自定义 API 工作流" : "内置 Wan 2.2 TI2V-5B" };
}

async function uploadReference(config, payload, mediaDir, options = {}) {
  const input = readPaidVideoFirstFrame(mediaDir, payload?.imageUrl);
  const form = new FormData();
  form.append("image", new Blob([input.buffer], { type: input.mimeType }), input.name || `mujing-${Date.now()}.png`);
  form.append("type", "input"); form.append("overwrite", "true");
  const response = await request(config, "/upload/image", { method: "POST", body: form }, options);
  const data = await readJson(response, "ComfyUI 图片上传响应", 1024 * 1024);
  if (!String(data?.name || "").trim()) throw new Error("ComfyUI 未返回参考图文件名。 ");
  return data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
}

async function submitComfyUIVideoTask(config, payload, mediaDir, options = {}) {
  if (!String(payload?.imageUrl || "").trim()) throw new Error("本地视频生成需要一张分镜参考图。 ");
  const image = await uploadReference(config, payload, mediaDir, options);
  const prompt = patchedWorkflow(config, payload, image);
  const response = await request(config, "/prompt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt, client_id: `mujing-${crypto.randomUUID()}` }) }, options);
  const data = await readJson(response, "ComfyUI 任务提交响应");
  if (!String(data?.prompt_id || "").trim()) {
    const nodeNames = data?.node_errors ? Object.keys(data.node_errors).join("、") : "未知节点";
    throw new Error(`ComfyUI 工作流校验失败（${nodeNames}）。请在 ComfyUI 中打开工作流检查模型名称与节点输入。`);
  }
  return { jobId: String(data.prompt_id), status: "queued", provider: "本地 ComfyUI" };
}

function outputFile(entry) {
  const files = [];
  for (const output of Object.values(entry?.outputs || {})) {
    for (const key of ["videos", "gifs", "images"]) if (Array.isArray(output?.[key])) files.push(...output[key]);
  }
  return files.find((file) => /\.(?:mp4|webm|mov|mkv)$/i.test(String(file?.filename || ""))) || files.find((file) => /\.(?:gif|webp)$/i.test(String(file?.filename || "")));
}

async function saveVideoResponse(response, mediaDir, filename, options = {}) {
  const extension = (path.extname(filename).slice(1).toLowerCase().match(/^(mp4|webm|mov|mkv|gif|webp)$/) || [])[1] || "webm";
  fs.mkdirSync(mediaDir, { recursive: true });
  const finalName = `local-video-${Date.now()}-${crypto.randomBytes(3).toString("hex")}.${extension}`;
  const temporary = path.join(mediaDir, `.${finalName}.part`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("ComfyUI 视频响应无法读取。 ");
  const declared = Number(response.headers?.get?.("content-length") || 0);
  if (declared > MAX_VIDEO_BYTES) { try { await reader.cancel(); } catch { /* The oversized stream is already rejected. */ } throw new Error("ComfyUI 输出视频超过 1GB，已停止下载。 "); }
  const handle = fs.openSync(temporary, "wx"); let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      total += value.byteLength; if (total > MAX_VIDEO_BYTES) throw new Error("ComfyUI 输出视频超过 1GB，已停止下载。 ");
      fs.writeSync(handle, Buffer.from(value));
    }
  } catch (error) { try { fs.closeSync(handle); } catch { /* Best-effort descriptor cleanup. */ } try { fs.unlinkSync(temporary); } catch { /* Best-effort partial-file cleanup. */ } throw error; }
  fs.closeSync(handle);
  try { await (options.probeMediaFile || probeMediaFile)(temporary, "video"); }
  catch (error) { try { fs.unlinkSync(temporary); } catch { /* Best-effort invalid-output cleanup. */ } throw new Error(`ComfyUI 输出不是可用视频：${error instanceof Error ? error.message : String(error)}`); }
  fs.renameSync(temporary, path.join(mediaDir, finalName));
  return finalName;
}

async function pollComfyUIVideoTask(config, payload, mediaDir, onProgress, options = {}) {
  const jobId = String(payload?.jobId || "").trim();
  if (!jobId) throw new Error("缺少本地 ComfyUI 任务 ID。 ");
  const response = await request(config, `/history/${encodeURIComponent(jobId)}`, { method: "GET" }, options);
  const history = await readJson(response, "ComfyUI 历史记录");
  const entry = history?.[jobId];
  if (!entry) return { jobId, status: "running" };
  const statusText = String(entry?.status?.status_str || "");
  if (/error/i.test(statusText)) return { jobId, status: "failed", error: "ComfyUI 工作流执行失败。请查看 ComfyUI 终端，通常是显存不足、模型文件名不匹配或节点参数错误。" };
  const file = outputFile(entry);
  if (!file) return entry?.status?.completed ? { jobId, status: "failed", error: "ComfyUI 已完成，但工作流没有输出视频文件。请使用 SaveWEBM、SaveVideo 或 VHS_VideoCombine 输出节点。" } : { jobId, status: "running" };
  onProgress?.("downloading");
  const params = new URLSearchParams({ filename: String(file.filename), subfolder: String(file.subfolder || ""), type: String(file.type || "output") });
  const videoResponse = await request(config, `/view?${params.toString()}`, { method: "GET" }, { ...options, timeoutMs: 5 * 60_000 });
  const filename = await saveVideoResponse(videoResponse, mediaDir, String(file.filename), options);
  return { filename, jobId, status: "succeeded" };
}

async function cancelComfyUIVideoTask(config, payload, options = {}) {
  const jobId = String(payload?.jobId || "").trim();
  await request(config, "/interrupt", { method: "POST" }, options);
  if (jobId) await request(config, "/queue", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ delete: [jobId] }) }, options);
  return { jobId, status: "canceled" };
}

module.exports = { baseUrl, cancelComfyUIVideoTask, patchedWorkflow, pollComfyUIVideoTask, readWorkflow, submitComfyUIVideoTask, testComfyUIConnection };
