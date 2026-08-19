# 幕境 0.3.4 最终审查收口结果

## 唯一最终包与最终门禁（2026-08-15 18:06 PDT；剩余 1 个 Important + 1 个文档 Minor 修复后独立重建现算）

本节取代本文下方所有旧轮次的“最终”措辞。下方出现的其他安装包/主程序/MP4 哈希和大小都只是历史轮次证据，不得视为最终发布数字。本轮严格只修复 IPv4 `240.0.0.0/4` 安全分类遗漏，并把旧包数字历史化；没有扩展产品功能，没有真实联网，没有读取或修改真实用户数据，没有创建 Git commit。

- 最终安装包：`release/MuJing-Setup-0.3.4.exe`；`140,747,102` bytes（`134.227 MiB`）；SHA-256 `1751925A424F420B0A7EC18112555B29B6F534CB6DA7CE38F4BE2055B8A544BA`；FileVersion/ProductVersion `0.3.4/0.3.4`；Authenticode `NotSigned`；Signer `none`；最后写入 `2026-08-15 18:06:55 -07:00`。
- 最终解包主程序：`release/win-unpacked/MuJing.exe`；`225,533,440` bytes（`215.085 MiB`）；SHA-256 `80C85D448A3F4A4CA24EF108B923C3898BCCCB34154BE055D58C377695CE9F69`；FileVersion/ProductVersion `0.3.4/0.3.4.0`；Authenticode `NotSigned`；Signer `none`；最后写入 `2026-08-15 18:06:32 -07:00`。
- 最终 Fake Live MP4：`1,321,602` bytes；SHA-256 `CAB9F30C8846BC4F4F49BB03EDB165F8455AB1CA5FDADD626BC62D2BEA0C8B06`；H.264/AAC/mov_text、1920×1080、30fps、115.000 秒、16/16 中点与 source-duration 绑定、完整解码 0 错误。
- spawn-boundary race MP4：`15,759` bytes；SHA-256 `1ECF92A4C43BEBCF6B4D2BE9CC99C54464D868360172E9E5D9191AD4ED9C5E2F`；在最终 descriptor 验收后、ffmpeg spawn 前替换 staged pathname，策略为 `opened-verified-descriptor-wins`，replacement 未进入最终画面/配音，manifest SHA-256 与实际输送原字节一致，render job 残留 0。

### 本轮剩余 1 个 Important + 1 个文档 Minor

1. `UNSAFE_IPV4_RANGES` 增加完整 `240.0.0.0/4` reserved 分类。公共 Provider 对直接 IP、DNS 任一答案、redirect 每一跳及 IPv4-mapped IPv6 都在 transport 前拒绝该段（包括 `255.255.255.255`）；既有 `224.0.0.0/4` multicast 阻断、合法 public 连接及显式 private provider exact-origin 例外保持不变。
2. 两份报告顶部只保留最后一次 `desktop:build` 后现算的一组包数字，上一组最终数字移入下方历史快照。

### 最终 RED / GREEN 与门禁

- RED：先加入直连 `240.0.0.1`、`255.255.255.255`、DNS `240.0.0.2`、redirect `240.0.0.3`、`::ffff:240.0.0.1` 及边界正负向用例；修正测试桩后聚焦为 `1/7` pass、`6/7` fail，明确证明五类 240/4 路径会进入 transport。全部使用 fake transport/resolver，没有真实联网。
- GREEN：`tests/provider-media-url-security.test.mjs` 为 `16/16`；最终 `npm test` 为 `153/153`。所有 240/4 禁止目标为 0 transport；redirect 仅允许公共首跳，保留段目标跳为 0 transport；`239.255.255.255` 仍阻断，合法 public 与 private exact-origin 均通过。

| 最终门禁 | 结果 |
|---|---|
| `node --test tests/provider-media-url-security.test.mjs` | 16/16 pass |
| `npm test` | 153/153 pass |
| `npm run lint` | 通过，0 error / 0 warning |
| `npm run build` | 通过，Vinext 5/5 |
| `npm run desktop:build` | 通过；最后一次独立 Electron 43.4.0 x64 + NSIS 重建 |
| `git diff --check` | 通过 |

持久证据：`C:\Users\Mr.X\hermes-output\mujing-0.3.4\e2e-evidence\E2E_REPORT.md`。工作树保持未 commit。

---

## 本轮中间重建历史（以下均非最终）

- 2026-08-15 15:58 PDT：installer `140,742,706` bytes，SHA-256 `6431BF43EB837BA13E0AF29A000F6899BDC689C1CF409DF35780644D50AE0E99`。
- 2026-08-15 16:22 PDT：installer `140,746,950` bytes，SHA-256 `6CF207DB22A75AF6F02A90EF50FA032F3C0E1FE27F0DF3547108478076186A39`。
- 2026-08-15 16:27 PDT：installer `140,747,048` bytes，SHA-256 `FC7EF396F09DE24A1409B4F2E2915F29A4ECDDB0EB10A703D70ACB79F8722FEE`。
- 2026-08-15 16:32 PDT：installer `140,747,059` bytes，SHA-256 `371C58F5148A1C78A8B9CC634E6969A2B636AF5E1F3294BA79D72A99DF4E3AED`；win-unpacked exe `225,533,440` bytes，SHA-256 `BDDA9D5319F19FADAE3107F902A243A6F236388CC16584F4A86FF5D03A5ECDA5`。

# 历史轮次记录（以下哈希/大小均非最终）

# 幕境 0.3.4 阻断问题修复结果

## 最终媒体完整性/资源边界验收（2026-08-15，取代旧媒体完整性结论）

本轮严格只处理独立验收提出的 5 个 Important；没有调用真实付费 API，没有读取或修改真实用户项目、Key 或 userData，没有创建 Git commit。

### TDD RED / GREEN

- 先新增 `tests/media-integrity-round5.test.mjs`、`tests/provider-streaming-round5.test.mjs`，并扩充图片与 UI 失效测试，再执行：`node --test tests/media-integrity-round5.test.mjs tests/provider-streaming-round5.test.mjs tests/media-save-data-url.test.mjs tests/workflow-safety.test.mjs`。
- RED：23 tests，13 pass / 10 fail。失败真实复现了 0.5 秒旧配音被 `apad` 补成 4 秒、配音替换仍导出、1 秒视频冒充 4 秒、16 MiB voice data URL 未前置阻断、伪图片被写盘、Provider 缺少流式落盘、文稿编辑未失效配音。
- GREEN：聚焦媒体/付费边界回归 62/62；新增重启持久化用例单独 5/5；最终 `npm test` 为 85/85。

### 1. 配音可信 provenance 与当前文稿绑定

- 新增 `desktop/media-provenance.cjs`。主进程在 Provider speech 或 Windows SAPI 真正写出音频后，自行对完整文稿做 NFKC、换行规范化与首尾清理，再计算 SHA-256；自行 ffprobe 音频流实际时长，并以流式 SHA-256 绑定实际文件字节。
- `media-provenance.json` 只保存随机 media ID、受控相对路径、文稿 SHA-256、文件 SHA-256、实际时长、生成来源和时间；用同目录临时文件 + atomic rename 写入，不保存 API Key。重启后仍可校验。
- 导出重新计算当前 script hash，并核对可信记录、文件字节 hash 和重新 ffprobe 的真实时长。缺记录、旧项目、文稿不匹配、文件替换或时长记录漂移全部 fail-closed，并要求重新生成配音。
- Renderer 的键入、导入、清空和撤销清空统一走 `updateScript`；文稿变化立即清空 voice URL/provenance/播放状态并给出中文原因。旧草稿只有 voice URL 而没有可信公开摘要时，UI 不再显示为 ready；主进程仍是最终安全边界。

### 2. 配音与视频真实时长覆盖

- 新增打包版 `ffprobe.exe`。导出前逐个探测真实 audio/video stream duration，统一容差为 0.25 秒。
- 配音实际时长必须与完整时间线在 ±0.25 秒内；已移除 `apad`。0.5 秒音频/4 秒时间线测试被拒绝，正式输出为 0。
- 每个 Provider 视频记录 `requestedDuration/sourceDuration/finalStart/finalEnd`。低于声明时长超过 0.25 秒立即阻断；容差内只做极小 PTS 调整，较长视频安全 trim，未使用 `tpad` 或冻帧掩盖短源。1 秒视频/4 秒镜头测试被拒绝，正式输出为 0。
- 最终文件先写 `.partial.mp4`，并在发布前复核 video/audio/subtitle/container 四类时长均覆盖 115 秒时间线；失败删除 partial，不发布目标文件。

### 3. 图片真实字节解码

- `desktop/media-tools.cjs` 先识别 PNG/JPEG/WebP 实际格式，再把同一个不超过 12 MiB 的 Buffer 送入 ffmpeg 完整解码一帧；声明 MIME 必须与实际格式一致。
- 通用 data URL 保存、付费首帧 data URL、本地受控首帧、图片 Provider base64 与下载响应均复用该边界。脚本字节伪装 PNG、`NOT_AN_IMAGE`、截断 PNG/JPEG/WebP、MIME 错配均为 0 write / 0 paid POST。
- 本地付费首帧仍使用 descriptor stat + MAX+1 有界读取；验证、digest 和 Provider upload 使用同一个 Buffer，不二次读取可变路径。

### 4. 有界/流式媒体 I/O

- 完整导出拒绝 renderer 提供 voice/video data URL，只接受主进程 media 根目录内经 stat、realpath、大小上限和 ffprobe 验证的文件。16 MiB voice data URL 在任何 base64 解码和 render-job 写入前同步拒绝。
- Provider 图片上限 12 MiB、speech 上限 64 MiB、付费视频下载上限 1 GiB。`Content-Length` 先检；无长度响应逐块计数；媒体先流式写同目录 `.part`，验证成功后 atomic rename。
- 超限、字节数与 Content-Length 不符或传输中断均 cancel/close 并删除临时文件，0 正式媒体文件；Provider 路径已移除未知大小响应的 `response.arrayBuffer()`。

### 5. Fake Live 完整 E2E 证据

- `npm run e2e:fake-live`：通过。16 image POST、16 video POST、16/16 视频 ready；成功镜头零重复 POST；原失败任务继续 GET 同一 task ID 后恢复。
- 完整成片 `fake-live-final.mp4`：1,300,902 bytes，SHA-256 `AB571AEB0A96460F40DB3E6FB8F33E7BA1A0EA136C135D5925A59CF50C8224D6`，H.264/AAC/mov_text，1920×1080，30fps，video/audio/subtitle/container 均为 115.000 秒，完整解码 0 错误。
- manifest v2 的可信配音 script SHA-256 为 `dfca7ccc532ab53f5a9bf9100732ed606bef9ac162e5ba7c554cec9c97397e6d`，原始配音时长 115.000 秒；16/16 镜头的 `sourceDuration >= requestedDuration - 0.25`，并保留原有逐镜头 SHA-256/中点画面绑定验证。
- Fake Live 额外生成 1 秒受控视频替换第 1 个 10 秒镜头，主进程负向导出被阻断，`fake-live-short-video-must-not-exist.mp4` 不存在；证据为 `fake-live-short-video-negative.json`。
- `npm run e2e:demo`：通过；诚实范围仍为文稿、角色、16 分镜、16 图片，`completeMovieAccepted=false`，不冒充完整成片。

### 最终命令与安装包

| 命令 | 结果 |
|---|---|
| `npm run e2e:fake-live` | 通过；可信配音、16/16 source duration、最终四类时长和短视频负向用例均通过 |
| `npm run e2e:demo` | 通过；明确为图片阶段演示范围 |
| `npm test` | 85/85 pass |
| `npm run lint` | 通过，0 error / 0 warning |
| `npm run build` | 通过，Vinext 5/5 |
| `npm run desktop:build` | 通过，Electron 43.4.0 x64 + NSIS |
| `git diff --check` | 通过 |

- 安装包：`release/MuJing-Setup-0.3.4.exe`，140,735,962 bytes（134.216 MiB），SHA-256 `66F7AAC1DF96D573A2E9229885D2733C53CC762AE009637EF4C3547A9F05DF52`，生成时间 `2026-08-15 14:44:02 -07:00`。
- FileVersion/ProductVersion：`0.3.4/0.3.4`；Authenticode：`NotSigned`，Signer：none。
- 解包主程序：225,533,440 bytes，SHA-256 `DB322394741E80E7B8DFC2CBC88871281D206AEC9A9F50CD4285F2E664C8D156`，FileVersion/ProductVersion `0.3.4/0.3.4.0`，Authenticode `NotSigned`。
- 包内资源：`ffmpeg.exe` 82,797,568 bytes；`ffprobe.exe` 63,059,968 bytes。`app.asar` 已核对包含 `media-provenance.cjs`、`media-tools.cjs`、`providers.cjs` 与 `render.cjs`。

诚实剩余限制：按要求未连接真实供应商，因此未验证线上模型质量、真实计费或供应商响应漂移；未把 NSIS 安装进真实用户目录；安装包没有正式 Authenticode 签名且仍使用默认 Electron 图标。

日期：2026-08-15
项目：`C:\Users\Mr.X\Documents\video editer\storyforge-studio`
分支 / HEAD：`main` / `e0a5798a0a2abd6e09da2f5fd23956bd4fda1848`

## 结论

独立审查提出的 6 个阻断问题均已按最小范围修复，新增的关键覆盖均为可执行行为测试或临时目录测试。最终完整门禁通过并重新封装了 0.3.4。

本轮没有调用真实服务商或付费 API，没有上传素材，没有读取、迁移或修改真实用户项目/API Key/缓存，没有创建 Git commit，也没有生成测试签名证书。

## 六项修复

### 1. 付费 POST 的主进程耐崩溃 journal

- 新增 `desktop/paid-task-journal.cjs`，journal 位于 Electron `app.getPath("userData")/paid-video-tasks.json`。
- 以稳定 `projectId + shotId + provider + requestFingerprint` 建立请求身份。`projectId` 在付费 IPC 前同步写入项目草稿，避开原有 500ms 自动保存窗口。
- journal 只写项目/镜头标识、服务商、状态、task ID、提交/更新时间、请求 SHA-256 指纹及历史 task ID；不写 prompt、API Key、参考图内容或服务商错误回显。
- 每次普通 POST 前先以临时文件 + fsync + replace/rename 原子写入 `submission_pending`；若系统替换语义不允许覆盖，则使用可恢复 `.bak` 交换并在异常时回滚/清理临时文件。
- 服务商返回 task ID 后，先原子写入 `active + taskId`，再把 ID 返回 renderer。ID 落盘失败时不会把成功假象返回页面，后续普通调用会 fail-closed。
- 同一项目/镜头已有 task ID 时，普通 submit 直接恢复旧 ID，POST 增量为 0；`submission_pending/unknown` 且无 ID 时阻止普通重提，并说明服务商可能已受理。
- 明确重提使用单独的 `ai:video-resubmit` IPC，要求“放弃旧记录”和“新增费用”两个主进程确认位；普通 submit 即使夹带 `explicitResubmit` 等参数也无法绕过。
- 不假设 Seedance/OpenAI Video 支持安全幂等键；未知 ID 风险无法伪装成已恢复。

### 2. 非显式路径不再丢付费 task ID

- 风格切换、镜头图片重做、清空分镜、重新设计和重新生成故事板都会先检查 React 状态和主进程 journal。
- 只要镜头仍有运行中、失败待恢复、本地暂停或未知受理风险的付费任务，操作即被阻止，并提示先继续轮询原任务或走独立明确重提。
- 已完成且视频已保存本地的任务允许继续编辑，但风格/图片重做仍保留 task ID、provider 和已保存视频；普通视频生成仍恢复 journal 中的原任务，不会隐式新增 POST。
- renderer 启动时从主进程 journal 恢复 autosave 尚未写入的 task ID；若只有 pending/unknown 意图，则标记未知受理风险并锁住普通重提。

### 3. 镜头级停止本地排队/轮询

- 每个未完成镜头新增“停止本地排队”或“停止本地轮询”。
- 未 POST 的镜头可标记为已取消；已有 task ID 时立即停止本地轮询，保留 task ID/provider/journal，并明确显示“仅停止本地轮询，远端任务可能继续并计费”。
- 120 次轮询通过可注入的 `pollPaidTaskUntilSettled` 执行，在请求前、请求后、等待后均检查镜头和全局停止标记；用户操作后最多一个 10 秒轮询间隔停止，不再等待完整 20 分钟。
- “继续轮询原任务”复用原 ID；全局停止也会及时退出当前轮询，并为已有 ID 的后续镜头保留身份。

### 4. 空格/全角占位名阻断

- 角色名称先做 Unicode NFKC、首尾清理、空白合并和大小写归一；占位比较再移除空白。
- `角色 1`、`角色   2`、`角色　１`、`角 色 ２`、`ｃｈａｒａｃｔｅｒ　１` 等变体均被阻断。
- `角色设计师林默`、`林默 / 林墨` 等真实名称仍通过。

### 5. API Key 不再由 settings:get 返回 renderer

- 新增 `desktop/settings-store.cjs`。`settings:get` 和 `settings:save` 的返回值只含非敏感设置及 `hasKey`，不含 `apiKey` 字段或旧密钥内容。
- 密码框默认空白；已保存时显示“已保存；留空不会覆盖旧密钥”。空白保存和空白连接测试由主进程安全合并已保存密钥。
- 只有用户本次主动输入新 key 时 renderer 才短暂持有输入；保存成功后输入被清空。
- 清除 key 有独立确认和 `clearApiKey: true` 语义，只有保存该明确操作才删除旧 key。
- 数据说明已改为真实边界：密钥加密存储；读取设置不返回旧明文；发起服务商请求时只由主进程解密使用。

### 6. 清空全部分镜的一次完整撤销

- 清空前先阻止任何未解决付费任务，不能依赖撤销来找回收费任务。
- 安全清空会深拷贝一次完整 `Shot[]` 会话快照，包括描述、时间、确认状态、素材引用、task ID/provider、生成状态和错误状态。
- 清空后在当前分镜页显示“撤销清空全部分镜”；撤销完整恢复快照。下一次成功清空会替换上一次快照。
- 清空不会删除主进程 journal、本地媒体缓存、服务商副本或导出成片。

## TDD：RED / GREEN 证据

### RED

- 修改前基线：`npm test` 为 18/18 通过，但付费测试仅验证同一进程内一次 POST + 一次 GET，取消/清空多为源码正则。
- 先加入 journal、设置边界、占位名、破坏动作、轮询停止和分镜快照行为测试后：26 项中 17 通过、9 失败。
- 失败原因分别为：journal 模块缺失、设置安全模块缺失、空格/全角占位名通过、破坏操作守卫缺失、轮询取消函数缺失、完整分镜快照缺失。

### GREEN

- 主进程/提供方 fake-fetch + 临时目录测试覆盖：
  - 响应丢失后第二次普通调用 POST 总数仍为 1；
  - 无 task ID 响应后第二次普通调用 POST 总数仍为 1；
  - 已写 pending 的崩溃窗口重启后普通调用 POST 总数为 0；
  - journal 已有 ID 时重启后的普通调用新增 POST 为 0；
  - 普通 submit 的伪重提参数无效，只有独立双确认 resubmit 才把 POST 从 1 增至 2；
  - 原子 replace 失败时 POST 总数为 0，临时文件被清理；
  - journal 文件不出现 fake prompt、API Key 或参考图内容。
- 轮询行为测试证明：第一次 GET 后在等待阶段点击停止，后续 GET 次数保持为 0；task ID/provider 保留并返回本地暂停状态。
- 破坏性行为测试证明：style change、image regeneration、storyboard clear/redesign 对未解决付费任务全部返回 blocked；普通后续动作仍选择 resume 原 ID。
- 设置纯函数测试证明：公开设置无 `apiKey`，空白保存/测试保留旧 key，明确清除才删除。
- 第一轮结束时 `npm test`：27/27 通过；补充审查后的最终结果见文末，为 31/31。

所有网络相关测试均使用 `global.fetch` fake 和 `example.invalid`，没有真实请求。

## 第一轮门禁（补充审查前）

| 命令 | 结果 |
|---|---|
| `npm test` | 当时通过；27 tests，27 pass，0 fail；总计约 5.5s |
| `npm run lint` | 通过；0 error，0 warning；约 5.8s |
| `npm run build` | 通过；Vinext 5/5 构建完成；约 4.3s |
| `npm run desktop:build` | 通过；Electron 43.4.0 x64 + NSIS；约 42.6s |
| `git diff --check` | 通过 |

`electron-builder` 仍提示项目未配置应用图标并使用默认 Electron 图标；本轮未扩展该非阻断项。

## 安装包核验

- 路径：`C:\Users\Mr.X\Documents\video editer\storyforge-studio\release\MuJing-Setup-0.3.4.exe`
- 生成时间：`2026-08-15 10:45:57 -07:00`
- 字节大小：`125,359,658` bytes（`119.552 MiB`）
- SHA-256：`09CCBD3B3926F3E694794762F17527F1DED8B336423E17C62AAF3FC14BD3AEF2`
- FileVersion：`0.3.4`
- ProductVersion：`0.3.4`
- ProductName：`幕境`
- FileDescription：`幕境 AI 视频创作工作台桌面版`
- 安装包 Authenticode：`NotSigned`
- 解包主程序：FileVersion `0.3.4`，ProductVersion `0.3.4.0`，Authenticode `NotSigned`
- `app.asar` 已核验包含 `desktop/paid-task-journal.cjs` 和 `desktop/settings-store.cjs`。
- 未生成 `.pfx/.p12/.cer/.crt/.pem` 测试证书，未冒充正式签名。

## 本轮六项修复直接修改/新增的文件

- `app/page.tsx`
- `app/workflow-safety.mjs`
- `desktop/main.cjs`
- `desktop/preload.cjs`
- `desktop/paid-task-journal.cjs`（新增）
- `desktop/settings-store.cjs`（新增）
- `tests/paid-task-journal.test.mjs`（新增）
- `tests/settings-boundary.test.mjs`（新增）
- `tests/workflow-safety.test.mjs`
- `tests/ux-safety.test.mjs`
- `CODEX_0.3.4_RESULT.md`

当前待审 0.3.4 工作树还包含本轮开始前已有的 `app/globals.css`、`desktop/providers.cjs`、`package.json`、`package-lock.json` 和 `tests/rendered-html.test.mjs` 等改动；本轮没有回滚或扩大这些既有改动。release 目录按现有忽略规则未进入 Git。没有创建 commit。

## 剩余不可消除风险

1. 按要求未调用真实服务商，因此未验证当前线上响应格式、计费规则、任务状态枚举或下载 URL 行为；这些仍以服务商实际结果为准。
2. 服务商受理 POST 但连接在 task ID 返回前中断时，客户端无法凭空恢复未知 ID。当前实现会持久化 `unknown` 并永久阻止普通重提；用户若明确放弃旧记录并双重确认重提，旧远端任务仍可能继续并产生重复费用。这是无安全幂等键/服务商查询能力时无法消除的风险。
3. “停止本地轮询”不等于远端取消。远端任务可能继续运行和计费；UI、状态和报告均明确保留这一边界。
4. 安装包未使用正式代码签名证书，Windows 可能显示未知发布者警告；项目也仍使用默认 Electron 图标。
5. 本轮没有启动真实安装窗口或修改真实用户数据做端到端人工验收；验证范围为离线行为测试、构建、封装、包内容和 PE 元数据/签名核验。

## 补充独立审查：PAID-005 / PAID-006

本节由第一轮六项修复完成后的下一轮 Codex 独立核查并补强。采用 PAID-005 的方案 A：只要相关镜头仍保留未解决的 `videoTaskId`，就不允许改变该任务来源输入；不把旧任务结果静默解释成新输入结果。

### PAID-005：可变输入与旧付费任务来源漂移

- `guardPaidTaskDestruction` 扩展为统一输入守卫，行为测试逐项覆盖 `visual`、首帧、全局 style、全局 ratio 和角色资料/母版变化。
- 镜头画面描述编辑按镜头检查；图片重做/首帧替换按镜头检查；style、ratio 和角色名称、启用状态、外观描述、参考图、生成母版按全项目检查。
- 桌面端 journal 尚未完成启动核验时，上述编辑 fail-closed；journal 读取失败也保持锁定，避免 autosave 尚未恢复 task ID 的短窗口造成输入漂移。
- 用户提示明确要求先继续轮询原任务，或走“明确放弃旧任务并再次确认可能新增费用”的独立路径。普通生成入口不会把旧结果静默绑定为修改后的输入。
- journal 仍只保存 SHA-256 请求指纹及必要的项目/镜头、provider、状态、task ID 和时间元数据；既有磁盘行为测试继续验证完整 prompt、图片数据和 API Key 不会写入 journal。

### PAID-006：task ID 缺 provider 时错误回退

- `videoTaskAction` 现在把恢复身份定义为完整的 `taskId + provider`；有 ID 无 provider 返回 `blocked`，提示“旧项目缺少原服务商，无法安全轮询”。
- renderer 已删除 `target.videoTaskProvider || providers.video`；主进程也删除 `journalEntry?.provider || payload?.provider`。普通提交和明确重提只有在主进程 journal 已原子保存 provider 后才向页面返回完整身份。
- 主进程 `resolveTaskPair` 先按 `projectId + shotId + taskId` 精确查 journal；有原 provider 时忽略 UI 当前全局 provider，并只使用原 provider 的配置和 GET 路径。
- journal 没有 provider 且页面也没有已保存的原 provider 时，在配置解析和网络调用前 fail-closed；不会向任意当前 provider 发 GET，更不会因此发 POST。
- `markPollResult` 同样改为按项目、镜头和 task ID 精确更新，避免不同项目偶然相同 task ID 时串写记录。

### 补充 TDD：RED / GREEN

- RED：定向运行 15 项时 11 通过、4 失败。失败分别证明旧 `videoTaskAction` 未绑定 provider、缺 provider 的错误文案/路径不满足 fail-closed，以及五类输入守卫提示尚未满足补充要求。
- GREEN：定向 PAID 测试 15/15 通过；最终完整测试 31/31 通过。
- 缺 provider 行为测试使用 fake manager，断言 `0 GET / 0 POST`。
- journal provider 恢复测试模拟 UI 当前选择 `OpenAI Video`、journal 原 provider 为 `Seedance`，最终调用记录严格为一次 `GET Seedance/original-task`，无 POST。
- 网络测试全部使用 fake fetch、fake manager 或 `example.invalid`，未调用真实服务商和付费 API。

### 补充后的最终门禁与封装

| 命令 | 结果 |
|---|---|
| `npm test` | 通过：31 tests，31 pass，0 fail；包含完整 build |
| `npm run lint` | 通过：0 error / 0 warning |
| `npm run build` | 通过：vinext 5/5 |
| `npm run desktop:build` | 通过：Electron 43.4.0 x64 + NSIS；约 42.1s |
| `git diff --check` | 通过；仅既有 LF→CRLF 提示 |

补充封装产物仍为 `release/MuJing-Setup-0.3.4.exe`，其最终信息以上方“安装包核验”更新后的值为准。额外包内核验结果：

- `app.asar` 包含 `desktop/paid-task-journal.cjs`，其内容含缺 provider fail-closed 路径。
- `app.asar` 的编译 renderer chunk 同时包含 `visual-change`、`first-frame-change`、`style-change`、`ratio-change`、`character-profile-change` 守卫。
- `app.asar` 的 `desktop/main.cjs` 包含 `resolveTaskPair(payload)`，且包内不存在已知的全局 video provider 回退表达式。
- 安装包与解包主程序 Authenticode 均为 `NotSigned`；未生成测试证书；仍使用默认 Electron 图标。

## 第三轮修复：最终独立审查剩余 3 个付费任务阻断项

本轮只修改 `desktop/paid-task-journal.cjs`、`tests/paid-task-journal.test.mjs` 和本结果文档；没有扩展产品功能、没有调用真实付费 API、没有修改真实用户数据、没有创建 Git commit。

### 修复结果

1. 普通 poll 现在必须从 journal 唯一命中已持久化的 `projectId + shotId + taskId` 记录，provider 只取该记录中的原 provider。空 journal、未知/不匹配 task ID 在配置或网络调用前返回中文阻断错误，均为 `0 GET / 0 POST`。renderer 篡改 provider 时只使用 journal 原 provider。普通 poll 不再自动调用或暴露 `recordRecoveredTask`；本轮没有保留旧任务导入入口，因此旧项目缺少 journal 绑定时直接阻断。
2. 普通 submit 使用 SHA-256 请求指纹和 `provider + projectId + shotId` 做严格身份匹配。`prompt`、`ratio`、`duration`、`imageUrl`、`videoModel`、provider 任一变化都会在网络前阻断，提示先恢复旧任务或走独立明确放弃/重提流程；完全一致才以 `0 POST` 恢复原 task ID。
3. 主进程 manager 增加 per-project+shot single-flight 互斥，覆盖普通 submit 和明确 resubmit 的 journal 检查、intent 原子写、POST、task ID 原子落盘。三个同镜头并发 resubmit 只产生一个新 POST，并恢复同一个新 task ID；不同 shot 可并行。异常会释放锁，但 `unknown` journal 继续阻止普通重试。意外 task ID 冲突会原子保留全部 ID、标记 `task-id-conflict` 并阻断后续操作。

journal 仍只保存非敏感身份、状态、SHA-256 请求指纹、task ID/provider/时间及历史 task ID，不保存完整 prompt、图片内容或 API Key。

### 第三轮 TDD：RED / GREEN

- RED：先新增 fake fetch + 系统临时 journal + 并发 Promise 行为测试，然后实际运行 `node --test tests/paid-task-journal.test.mjs`。结果为 12 tests：8 pass、4 fail。四个失败分别证明：无绑定 renderer 身份仍能 GET、输入变化仍恢复旧 ID、同镜头并发重提产生两个新 POST、冲突 task ID 被覆盖。
- GREEN：最小修复后同一定向命令为 12/12 pass。测试逐项覆盖空 journal 携带 provider、journal task ID 不同、provider 篡改、六类指纹变化、完全一致恢复、三个同镜头并发重提、不同 shot 并行、POST 异常后锁复用和 unknown 防重提、冲突 ID 审计保留。
- 最终完整 `npm test` 为 37/37 pass；所有网络相关测试均使用 fake fetch 和 `example.invalid`，临时 journal 位于系统临时目录并在测试后删除。

### 第三轮最终门禁与重新封装

| 命令 | 最终结果 |
|---|---|
| `npm test` | 通过：37 tests，37 pass，0 fail；包含完整 build |
| `npm run lint` | 通过：0 error / 0 warning |
| `npm run build` | 通过：Vinext 5/5 |
| `npm run desktop:build` | 通过：Electron 43.4.0 x64 + NSIS |
| `git diff --check` | 通过 |

第三轮重新封装产物（以下信息取代上文较早轮次的安装包哈希/大小）：

- 绝对路径：`C:\Users\Mr.X\Documents\video editer\storyforge-studio\release\MuJing-Setup-0.3.4.exe`
- 生成时间：`2026-08-15T11:49:08.1961884-07:00`
- 字节大小：`125,360,273` bytes
- SHA-256：`37B73D1CDA6AEA6F6CBEE97905AF03FB58E28BAAF1B4EC9D03207B04C11D945B`
- FileVersion：`0.3.4`
- ProductVersion：`0.3.4`
- ProductName：`幕境`
- FileDescription：`幕境 AI 视频创作工作台桌面版`
- 安装包 Authenticode：`NotSigned`
- 解包主程序：FileVersion `0.3.4`，ProductVersion `0.3.4.0`，Authenticode `NotSigned`
- `app.asar` 已确认包含本轮严格 journal 轮询、请求指纹匹配、per-shot 锁和 task ID 冲突审计实现，且不存在 `recordRecoveredTask`。
- repo 内未发现 Codex 输出 `.txt` 日志。

### 第三轮后剩余风险与未验证范围

1. 按要求没有连接真实服务商，因此仍未验证线上请求/响应格式、服务商幂等能力、实际状态枚举、下载 URL 和计费规则。
2. 服务商已受理 POST、但连接在 task ID 返回前中断的窗口无法由本机恢复未知远端 ID；当前仍以 `unknown` fail-closed。只有用户独立双重确认的明确重提才可继续，旧远端任务仍可能产生费用。
3. per-project+shot 互斥是单个 Electron 主进程内的内存锁；本版本单实例运行可覆盖正常路径，但没有做多进程/跨设备共享 journal 的分布式锁验证。
4. 没有启动真实安装 UI 或写入真实用户目录做人工端到端验收；验证范围为离线行为测试、构建、NSIS 封装、包内代码和 PE 元数据/签名。
5. 安装包没有正式代码签名，Windows 仍可能显示未知发布者；仍使用默认 Electron 图标。这两项是既有非本轮阻断项。

## 第四轮修复：最终独立审查剩余 3 个 Important 付费安全边界

本轮只修复 Endpoint/账户身份绑定、首帧真实字节绑定和主进程重提授权。没有扩展其他功能，没有联网或调用真实付费 API，没有读取或修改真实用户数据，没有创建 Git commit。测试全部使用 fake transport、系统临时目录、固定测试 secret、可注入时钟/随机数/原生确认回调；临时文件均在测试结束后删除，运行日志未写入 repo。

### 1. task 绑定原 Endpoint 与账户身份

- 新增 `desktop/paid-task-identity.cjs`。Endpoint 在 HMAC 前按 URL 语义规范化：协议/主机名大小写、默认端口、主机尾点、路径尾斜杠和非保留字符百分号编码的等价写法会得到同一身份；用户名密码、query/hash 和非 HTTP(S) Endpoint 在网络前阻断。
- Endpoint 与账户分别使用带域分离标签的 HMAC-SHA-256 指纹。账户不再使用可离线枚举的无盐裸 hash；journal 只保存 `endpointFingerprint` / `accountFingerprint`，不保存 Endpoint 明文或 API Key。
- 生产 secret 位于 Electron `userData/paid-task-identity.secret`，为 32 字节随机值。首次创建使用 `wx` 临时文件、`fsync`、权限 `0600` 和不覆盖已有目标的原子硬链接发布；不写日志。测试可注入固定 32 字节 secret。
- 如果已有 journal 身份而 secret 缺失、不可读或长度损坏，poll/submit/resubmit 全部 fail-closed，不会生成新 secret 冒充旧身份。
- journal 现在把 `projectId + shotId + taskId + provider + Endpoint 指纹 + 账户指纹` 作为轮询前的完整绑定。主进程仍先从 journal 恢复原 provider，再用当前解密配置重算 Endpoint/账户身份；不一致返回中文提示，严格 `0 GET / 0 POST`。
- 普通 submit 恢复旧 ID 前执行相同核对。设置仍允许保存，但任何旧任务在 Endpoint/key 改变后都会被 poll/submit 边界阻断，绝不会把旧 task ID 发往新 Endpoint/账户。

### 2. 请求指纹绑定真实首帧字节

- 新增 `desktop/media-input.cjs`。主进程在写 submission intent 和调用 provider 前，严格解析当前支持的 `data:image/(png|jpeg|webp);base64` 或 `/__media/<单文件名>` 本地媒体 URL。
- 本地媒体必须实际存在、可读取、位于允许的 media 根目录内；`realpath` 会阻断符号链接越界，编码分隔符、`..`、`file:`、缺失文件和非法 base64 均在任何 POST 前失败。
- 首帧只读取一次为 Buffer，同时计算 SHA-256；请求指纹只使用 `imageDigest`，不再使用 `imageUrl` 字符串。manager 把同一 Buffer 传给 provider，`providers.submitVideoTask` 在 POST 前再次核对 Buffer digest，然后直接用该 Buffer 构造 Seedance data URL 或 OpenAI multipart Blob，不会重新读取可变文件。
- journal 只保存 SHA-256 `imageDigest` 和总请求指纹，不保存原始字节、base64、完整 data URL、完整路径、prompt、API Key 或服务商错误回显。
- 因此同 URL 字节变化会在第二个 POST 前阻断；同字节的安全等价本地 URL 可以 `0 POST` 恢复原 task ID。

### 3. 原生确认的一次性付费重提授权

- 新增 `desktop/paid-resubmit-authorization.cjs`。主进程通过 `ai:video-request-resubmit-authorization` 调用 Electron 原生 `dialog.showMessageBox`；提示明确包含服务商、镜头、放弃旧记录、旧远端可能继续计费和本次新增费用。
- 用户确认后主进程签发 32 字节随机 token，TTL 为 90 秒。token 只保存在主进程内存，不进入 journal、renderer 持久化或日志。
- token 绑定 Electron `webContents.id`、项目、镜头、provider、Endpoint/账户指纹和完整请求指纹。resubmit 在 POST 开始前同步删除并原子消费 token；拒绝、过期、重放、跨 sender、跨 shot、输入变化、Endpoint 变化和账户变化均为 `0 POST`，并发复用同 token 最多一个 POST。
- preload 新增“请求原生授权”IPC，并仅在 `resubmitVideoTask` 中携 token。renderer 已删除 `abandonOldRecord/additionalCharge` 两个布尔确认及其授权作用；直接伪造旧布尔值无效。
- 原有 per-project+shot 锁、submission intent→POST→task ID 原子 journal、异常释放锁和 POST 不确定时 `unknown` fail-closed 语义继续保留。

### 第四轮 TDD：RED / GREEN 真实证据

- RED：先新增 `tests/paid-boundaries-round4.test.mjs`，实际运行 `node --test tests/paid-boundaries-round4.test.mjs`，结果为 13 tests：1 pass、12 fail。
- RED 失败真实复现：同 provider 改 baseUrl/API key 仍 GET；普通 submit 在新 Endpoint/账户仍恢复旧 ID；journal 无 Endpoint/账户指纹；secret 未创建且缺失时仍轮询；同 URL 换字节仍恢复；同字节换安全 URL 被误阻断；缺失/越界/非法 data URL 仍 POST；provider 未收到同一已摘要 Buffer；重提授权模块不存在。
- GREEN：最小实现后第四轮定向测试为 18/18 pass。新增行为覆盖等价 Endpoint、secret 缺失/损坏、journal 无测试 key/原始字节/base64、真实 Seedance provider + fake fetch 上传同一 Buffer，以及拒绝/确认/重放/过期/跨 sender/跨 shot/请求指纹变化/Endpoint 变化/账户变化/并发 token。
- 旧回归测试已把非法伪 base64 夹具改为合法 data URL，并把旧 renderer 双布尔重提用例迁移到主进程 token；crash window、provider/task 严格绑定、请求字段指纹、同 shot 并发、锁异常释放、不同 shot 并行和 task ID 冲突审计继续通过。
- 最终 `npm test` 为 55/55 pass。所有网络相关测试均由 fake fetch/fake submit/fake poll 截获；未连接真实服务商。

### 第四轮最终门禁与重新封装

| 命令 | 最终结果 |
|---|---|
| `npm test` | 通过：55 tests，55 pass，0 fail；包含完整 build |
| `npm run lint` | 通过：0 error / 0 warning |
| `npm run build` | 通过：Vinext 5/5 |
| `npm run desktop:build` | 通过：Electron 43.4.0 x64 + NSIS，42.3s |
| `git diff --check` | 通过；仅 Git 的既有 LF→CRLF 工作树提示 |

第四轮重新封装产物（以下信息取代上文较早轮次的安装包哈希/大小）：

- 绝对路径：`C:\Users\Mr.X\Documents\video editer\storyforge-studio\release\MuJing-Setup-0.3.4.exe`
- 生成时间：`2026-08-15 12:47:12 -07:00`
- 字节大小：`125,363,257` bytes
- SHA-256：`F487FA307F681A25FB01F1EF5788990F01E9AAF0B65EABC5B2E57461CED9C2C3`
- 安装包 FileVersion：`0.3.4`
- 安装包 ProductVersion：`0.3.4`
- 安装包 Authenticode：`NotSigned`，Signer `(none)`
- 解包主程序：`release/win-unpacked/MuJing.exe`，`225,533,440` bytes，FileVersion `0.3.4`，ProductVersion `0.3.4.0`，Authenticode `NotSigned`
- `app.asar` 已确认包含 `desktop/main.cjs`、`desktop/preload.cjs`、`desktop/paid-task-journal.cjs`、`desktop/paid-task-identity.cjs`、`desktop/media-input.cjs` 和 `desktop/paid-resubmit-authorization.cjs`。

### 第四轮后未验证范围与保留风险

1. 按明确要求未连接真实服务商，未验证线上 Endpoint 的实际 URL 处理、请求/响应格式、任务状态枚举、下载地址、幂等能力和真实计费行为。
2. 服务商已收到 POST、但 task ID 响应丢失的不可消除窗口仍记为 `unknown` 并阻断自动重试；旧远端任务可能继续运行和计费。
3. secret 文件以创建模式 `0600` 并继承用户专属 `userData` 目录 ACL；Windows 对 POSIX mode 的表达有限，未做跨 Windows 账户的人工 ACL 穿透测试。secret 缺失/损坏会安全阻断，但需要用户人工核查旧任务。
4. 没有启动真实安装 UI，也没有向真实用户目录写入设置、journal、secret 或媒体做端到端人工验收；验证范围为离线行为测试、构建、NSIS 封装、包内容与 PE 元数据。
5. 安装包和解包主程序均未做正式 Authenticode 签名，Windows 可能显示未知发布者；仍使用默认 Electron 图标。这是既有发布风险，本轮未扩展处理。

## 第四轮追加修复：付费视频首帧 12 MiB 硬上限

本次只修复新发现的首帧内存耗尽阻断，没有扩展产品功能，没有连接真实服务商或调用付费 API，没有读取或修改真实用户数据，也没有创建 Git commit。行为测试使用 fake submit/fake poll、固定测试 secret 和系统临时目录；临时图片、稀疏文件与 journal 在测试结束后删除。

### 实现边界

- `desktop/media-input.cjs` 集中定义并导出 `MAX_PAID_VIDEO_FIRST_FRAME_BYTES = 12 * 1024 * 1024` 与中文文案 `首帧图片不能超过12 MiB`。每个首帧输入独立执行相同硬上限，所有拒绝均发生在付费 POST/GET 前。
- data URL 先只解析短 metadata 并限定 `image/png`、`image/jpeg`、`image/webp`，再依据尚未切片/解码的 base64 编码长度计算保守 decoded 上界。超限在 `Buffer.from` 前拒绝；未超限才检查字符、padding 与 canonical padding bits，解码后再次核对预期长度和真实 Buffer 字节数。
- 本地 media URL 继续先做协议、单文件名、规范路径和 `realpath` 根目录约束。文件以 descriptor 打开后用 `fstat` 核对普通文件、路径重新解析结果和打开对象身份；超限只经过 metadata 检查，不调用 `readFileSync` 或 `readSync`。允许大小的文件最多读取 `MAX+1`，读取后再次 `fstat`，文件增长、替换、长度或 mtime 变化均 fail-closed。
- SHA-256 只在上述验证完成后计算。manager 删除已解析请求中的原始 `imageUrl`，仍将同一个已验证 Buffer 和 digest 交给 provider；Seedance base64 与 OpenAI Blob 均由该 Buffer 构造。provider 遇到带 `imageUrl` 却没有已验证 Buffer/digest 的调用会在 POST 前拒绝，不再回退到可变路径二次读取。
- journal 的兼容摘要入口也复用同一个受限解析器，不再直接对任意 base64 执行 `Buffer.from`。journal 和一次性授权 token 仍不保存原始图片、base64 或完整 data URL；12 MiB 边界行为测试同时断言 journal 保持小型摘要记录。

### 严格 TDD：RED / GREEN

- RED：先新增 `tests/media-input-limit.test.mjs`，再运行 `node --test tests/media-input-limit.test.mjs`。结果为 9 tests：4 pass、5 fail。
- RED 的 5 个失败分别证明：统一限制常量/文案未导出、上限+1仍可产生 fake POST、16 MiB data URL 未在解码分配前阻断、超大稀疏文件仍会完整读取、文件在 stat 后增长仍未拒绝。
- GREEN：最小实现后同一命令为 9/9 pass；随后首帧限制、第四轮付费边界、journal 与 UX 相关回归合并运行 49/49 pass，最终 `npm test` 为 64/64 pass。
- 新测试覆盖：data URL 与本地文件正好 12 MiB 允许；12 MiB+1 严格 `0 POST`；16 MiB 编码长度门禁且注入 decoder 探针调用数为 0；超大稀疏文件 `0 readFileSync / 0 readSync / 0 POST`；descriptor `fstat` 后增长拒绝；畸形 base64、非图片 MIME、越界路径 `0 POST`；小型 PNG/JPEG/WebP 保持真实字节 Buffer 与 SHA-256 digest 绑定。

### 最终验证与重新封装

| 命令 | 最终结果 |
|---|---|
| `npm test` | 通过：64 tests，64 pass，0 fail；包含完整 build |
| `npm run lint` | 通过：0 error / 0 warning |
| `npm run build` | 通过：Vinext 5/5 |
| `npm run desktop:build` | 通过：Electron 43.4.0 x64 + NSIS，43.6s |
| `git diff --check` | 通过 |

本次重新封装产物（取代上文较早安装包信息）：

- 安装包：`C:\Users\Mr.X\Documents\video editer\storyforge-studio\release\MuJing-Setup-0.3.4.exe`
- 生成时间：`2026-08-15 13:07:00 -07:00`
- 字节大小：`125,364,258` bytes
- SHA-256：`05A68174113E6CD8E7EF904ECC1BB76B3FB83B9633C893F9D0E9D1B51414C28B`
- FileVersion / ProductVersion：`0.3.4` / `0.3.4`
- Authenticode：`NotSigned`，Signer `(none)`
- 解包主程序：`release/win-unpacked/MuJing.exe`，`225,533,440` bytes，SHA-256 `73B7C57A30A05FF3CA8B35D225955507373A94625EE7D479EC8C7028334CC81A`，FileVersion `0.3.4`，ProductVersion `0.3.4.0`，Authenticode `NotSigned`
- `app.asar` 已直接读取核验：包含 `desktop/media-input.cjs`、`desktop/paid-task-journal.cjs` 与 `desktop/providers.cjs`；其中包含 12 MiB 常量、descriptor `fstat/readSync` 受限读取、未验证 `imageUrl` 的 provider fail-closed 分支，且视频 provider 不再调用 `referenceDataUrl(mediaDir, payload.imageUrl)`。

## 第五轮：核心用户旅程端到端验收

本节取代上文“未启动真实安装 UI”的旧限制。验收严格使用隔离临时 userData、临时端口、合成 fixture 与本地 Fake Live Provider；没有调用付费 API、上传私人素材、读取真实 key/userData/项目，也没有关闭或干扰用户正在运行的旧版幕境。

### TDD 阻断与最小修复

1. 第一次真实 Electron Demo 旅程在角色页失败：旧逻辑不能从“修表师林默”和“电台记者苏晴”提取两个姓名。新增 `app/character-inference.mjs`，只补充角色+姓名识别、关系短语过滤和旧旁白/职业回退；同一 8 段 fixture 重跑通过。
2. 第一次 Fake Live 完整旅程后的绑定断言失败：图片生成状态更新调用 `syncShotCharacters`，覆盖服务商已返回并确认的 `videoPrompt`，后续视频 POST 丢失逐镜头 marker。最小修复为生成队列状态切换只修改 state/error；用户主动修改风格、比例、角色或画面时仍走原同步逻辑。重跑后 16 个图片/视频 marker、首帧摘要、task ID、provider 与结果 URL 全部逐镜头一致。

### 离线 Demo E2E

- 命令：`npm run e2e:demo`
- 真实 UI：空隔离 profile 输入完整文稿 → 林默/苏晴 → 16 镜头 → 全部确认 → 16 图片 → 16 Demo 视频状态 → 时间轴 → 完整本地配音 → MP4。
- 文稿为 8 个语义段落；镜头 narration 与提取字幕在去空白后均精确覆盖全文，开头/中间/结尾无遗漏、重复或乱序。
- 最终 `demo-final.mp4`：H.264 + AAC + mov_text，1920×1080，30fps，115.000 秒，3450 帧，2,488,307 bytes，SHA-256 `340FE9569476EC4D4A59F7A5FD0E800AC446DFD435605C46E5BA77496958E45C`。
- 音频与字幕流均为 115.000 秒；音轨平均音量 -23.6 dB。首/中/尾帧平均亮度 92/91/76，三个帧哈希不同。
- Demo 没有费用确认；Demo 画面为本地静态示意帧，导出视频真实可播放，但不代表真实模型质量。

### Fake Live Provider E2E

- 命令：`npm run e2e:fake-live`
- UI 实际切换真实模式，并逐次通过生成前确认；本地 HTTP fake 记录 1 storyboard POST、16 image POST、16 video POST、18 video poll GET、16 视频下载 GET、1 speech POST。
- `fake-video-01` 为 `running → succeeded`；`fake-video-02` 首次 `failed`，UI 单独“继续轮询原任务”后对同一 task ID GET 成功，POST 总数仍为 1。
- 成功镜头零重复 POST，最终 16/16 图片与视频 ready；speech 输入与完整 fixture 精确相等。

### 打包态与旧实例隔离

- 用户旧安装版保持运行时，使用独立 `--user-data-dir` 与端口成功启动最终 `release/win-unpacked/MuJing.exe`；两个窗口并存，未杀旧进程。
- 实际可见 0.3.4 主窗口加载文稿、角色、分镜、生成、成片、模型设置、数据费用和导出控件；preload bridge 可用，主进程返回的 userData 与隔离 profile 完全一致。
- 开发 E2E 导出路径必须同时满足 `!app.isPackaged` 与 `MUJING_E2E=1`；行为测试证明任何 packaged 状态均返回空路径，生产安装包不可用。

### 最终命令与产物

| 命令 | 结果 |
|---|---|
| `npm run e2e:demo` | 通过；真实 MP4 与 ffprobe/抽帧/全文覆盖 |
| `npm run e2e:fake-live` | 通过；16/16 任务、失败恢复、零重复 POST |
| `npm test` | 通过：68/68 |
| `npm run lint` | 通过：0 error / 0 warning |
| `npm run build` | 通过：Vinext 5/5 |
| `npm run desktop:build` | 通过：Electron 43.4.0 x64 + NSIS |
| `git diff --check` | 通过 |

最终安装包（取代上文所有旧哈希/大小）：

- `release/MuJing-Setup-0.3.4.exe`：125,365,058 bytes；SHA-256 `C00AD5200BC1C81FFB21E2DEDD0BEA9AFA575A50C6D5AB23E19F8BD75B6EB04D`；File/ProductVersion `0.3.4/0.3.4`；Authenticode `NotSigned`。
- `release/win-unpacked/MuJing.exe`：225,533,440 bytes；SHA-256 `C38E0CE80DBBDAC7294A585C5E2C9CBCA698BC7C14B6AF6F90DC68FE58C63CDE`；File/ProductVersion `0.3.4/0.3.4.0`；Authenticode `NotSigned`。
- 持久证据：`C:\Users\Mr.X\hermes-output\mujing-0.3.4\e2e-evidence\E2E_REPORT.md`。

剩余限制：未调用真实供应商，故未验证线上模型质量/计费/响应漂移；未把 NSIS 安装到用户目录，而是按验收允许范围运行最终 win-unpacked；未添加可选背景音乐；安装包仍未正式签名且使用默认 Electron 图标。没有创建 commit。

## 第六轮最终结果：3 个 Important 修复（取代旧完整成片结论）

本轮严格只处理用户指定的 3 项：完整成片 fail-closed、Fake Live 单一完整 MP4 E2E、通用图片 data URL 12 MiB IPC。没有调用真实付费 API，没有触碰真实用户数据，没有创建 commit。

### RED / GREEN

- 先新增 `tests/complete-export.test.mjs`、`tests/media-save-data-url.test.mjs` 并修改完整导出行为测试。
- RED 命令：`node --test tests/workflow-safety.test.mjs tests/complete-export.test.mjs tests/media-save-data-url.test.mjs`。
- RED 结果：11 tests，8 pass、3 fail；分别真实证明 UI 仍按旧图片条件判断、主进程缺严格完整渲染校验、通用 data URL 严格保存模块不存在。记录：`e2e-evidence/TDD_RED_2026-08-15.md`。
- GREEN：定向测试 14/14；最终 `npm test` 为 74/74。

### 1. 完整成片 fail-closed

- UI 只有在每镜头 `videoState=ready` 且 `videoUrl` 非空、`voiceUrl` 完整存在、镜头 narration 字幕规范化后按原顺序完整等于原文时才允许导出；否则原生禁用按钮并显示精确中文原因。
- main handler 在保存对话框前再次调用 `validateCompleteRenderPayload`；renderer 内部再次校验，并实际解析视频/配音本地文件。
- 移除 renderer 的图片 fallback 与无声导出分支；完整成片只使用镜头视频，且始终映射 AAC 配音。音频不足时补齐到总时长。
- 覆盖缺任一 videoUrl、视频非 ready、缺 voiceUrl、字幕覆盖不完整、非空 URL 对应文件不可用，以及完整输入允许。

### 2. Fake Live 单一完整旅程

- `npm run e2e:fake-live`：通过。真实 Electron UI 从隔离空项目输入完整 fixture，完成 16 分镜、16 图片、16 个逐镜头独特动态 H.264 provider 视频、时间轴、完整 speech/字幕，并在 UI 内点击导出得到 `fake-live-final.mp4`；未绕过 UI 直接调用 render。
- 请求：16 image POST、16 video POST，每镜头恰好一次；成功镜头不重复 POST。`fake-video-01` 为 `running → succeeded`；`fake-video-02` 为 `failed → GET 同一 task ID → succeeded`，仍为 1 POST。
- MP4：1,300,902 bytes；SHA-256 `AB571AEB0A96460F40DB3E6FB8F33E7BA1A0EA136C135D5925A59CF50C8224D6`；H.264 + AAC + `mov_text` 中文字幕；1920×1080；30fps；115.000 秒；完整解码 0 错误。
- narration、speech 输入、提取字幕均覆盖完整 fixture；音频流为 115.000 秒并覆盖总时长。
- `fake-live-render-manifest.json` 记录 16 个 shotId、脱敏 video URL、输入视频 SHA-256、duration 与最终时间段；不含密钥或私密绝对路径。
- 从 16 个镜头各自中点抽取 16 帧，与对应源视频中点逐一核对 marker、颜色、源哈希、帧哈希及感知哈希，16/16 通过。报告：`fake-live-16-shot-frame-binding-report.json`。
- Demo E2E 已诚实缩小为文稿/角色/16 分镜/16 图片，`completeMovieAccepted=false`；不生成视频、不进入时间轴、不导出 MP4。旧图片 fallback 产物移到 `legacy-invalid-demo-image-fallback/demo-final.INVALID-image-fallback.mp4`，不再作为有效证据。

### 3. 通用图片 data URL IPC

- 新增 `desktop/media-save-data-url.cjs`，只允许 PNG/JPEG/WebP，统一 12 MiB decoded 上限。
- 编码长度门禁发生在切片/`Buffer.from` 前；随后严格检查 base64 字符、padding 与 canonical padding bits；解码后再次检查真实 Buffer 上限与预期长度。
- 文件扩展名与可信前缀均由 MIME/主进程决定，不信 renderer 文件名。
- exactly 12 MiB 允许；12 MiB+1、16 MiB、畸形、非图片、解码后超限全部 0 `writeMedia`；16 MiB decoder 探针调用数为 0。

### 最终命令与产物

| 命令 | 最终结果 |
|---|---|
| `npm run e2e:fake-live` | 通过；生成并验证 Fake Live 完整 MP4 |
| `npm run e2e:demo` | 通过；明确仅分镜/图片范围 |
| `npm test` | 74/74 pass |
| `npm run lint` | 通过，0 error / 0 warning |
| `npm run build` | 通过，Vinext 5/5 |
| `npm run desktop:build` | 通过，Electron 43.4.0 x64 + NSIS |
| `git diff --check` | 通过；仅 Git 的既有 LF→CRLF 提示 |

最终安装包（取代本文件所有旧哈希/大小）：

- `release/MuJing-Setup-0.3.4.exe`：125,366,091 bytes（119.558 MiB）；SHA-256 `A848E7C2F388A43C1EE24491BC7B2F3EE3535952DE110DCD0F76C2451750341C`；FileVersion/ProductVersion `0.3.4/0.3.4`；Authenticode `NotSigned`，Signer `none`。
- `release/win-unpacked/MuJing.exe`：225,533,440 bytes；SHA-256 `24CD7A7D6FF65F2CEA22E5113D1DF47646991A5D0DBB083921E84595CD48168F`；FileVersion/ProductVersion `0.3.4/0.3.4.0`；Authenticode `NotSigned`。

持久证据：`C:\Users\Mr.X\hermes-output\mujing-0.3.4\e2e-evidence\E2E_REPORT.md`。

诚实剩余限制：按要求未连接真实供应商，未验证线上模型质量、实际计费与响应漂移；未把 NSIS 安装进真实用户目录；安装包没有正式 Authenticode 签名并仍使用默认 Electron 图标。

---

## 2026-08-15 最终独立对抗审查：剩余 4 类 Important

结论：**通过**。只修复指定四类问题；未调用真实付费 API、未读取或修改真实用户数据、未创建 Git commit。

### RED / GREEN

- 初始聚焦 RED：19/19 fail。精确复现工作量无上限、图片 `response.json()`、loopback 无界整体缓冲、render staging 缺失及 staged 删除不阻断。
- 新增 `export-limits-round6`、`provider-image-envelope-round6`、`local-server-streaming-round6`、`render-staging-round6` 共 26 个行为测试。
- 最终 `npm test`：111/111 pass；render staging/race 聚焦 4/4 pass。

### 修复结果

1. render：每次导出创建 192-bit 随机 job 目录；受控 voice/video/music 由已打开 descriptor 做真实字节复制，复制前后核对 `dev/ino/size/mtimeNs/birthtimeNs` 并增量 SHA-256；fsync/close/atomic rename 后，ffprobe、解码、manifest、ffmpeg 全部只消费同一 staged 路径。ffmpeg 前重验 staged identity/size/hash；manifest 不泄露 job/staged 路径；成功和所有失败都清理。
2. provider 图片：12 MiB 推导 16,777,216 base64 chars，加 1 MiB JSON 开销形成 17,825,792-byte envelope；URL JSON 1 MiB。Content-Length 超限 0 read/0 parse，chunked `+1` 立即 cancel；完成后才 UTF-8/JSON.parse，再严格 base64、decoded size、真实 MIME/解码。图片 `wx` temp + fsync + atomic rename，写/rename/传输失败 0 正式半文件。
3. 导出工作量：script 100,000 Unicode code points；1–500 shots；每镜头 0.5–300 秒；总时长 21,600 秒；shot 文本字段 10,000 code points；严格拒绝稀疏数组、非普通对象、accessor、NaN/Infinity。所有超限在 job/ffprobe 前给出含上限和实际值的中文错误；500/6 小时边界通过。
4. loopback：请求 32 MiB、worker 响应 128 MiB。请求 Content-Length + chunk 双限额，超限 413 且不 concat；GET/HEAD 不收 body。响应改为 reader 逐块写 Node response，处理 Content-Length、`+1` cancel、backpressure、client abort、worker interruption；不再 `arrayBuffer()`。`/api/export` 同受 32 MiB 主进程边界，核心 MP4 仍走 `project:export-video` IPC。

### Fake Live 与 race 证据

- Fake Live 保持 16 image POST、16 video POST、成功镜头 0 重投、可信完整配音、16/16 中点绑定；短视频负向 0 最终输出。
- `fake-live-final.mp4`：1,300,902 bytes；SHA-256 `AB571AEB0A96460F40DB3E6FB8F33E7BA1A0EA136C135D5925A59CF50C8224D6`；H.264/AAC/mov_text、1920×1080、30fps、115.000 秒、完整解码 0 错误。
- 新增 staging 后原路径替换 race：替换 voice 与 shot2 原文件后，输出仍为 staged 的 440Hz/红色视频；manifest 两个哈希均等于替换前原字节，job 残留 0、路径泄漏 0。证据 `fake-live-source-replacement-race.json`；race MP4 SHA-256 `F127BF446A5D123FCE36383D0D34B3EEB96BF3D5635103A3F5E90810D26B5537`。
- Demo 仍为 `completeMovieAccepted=false`，只生成 16 图片，视频/MP4 输出 0。

### 最终验收

| 命令 | 结果 |
|---|---|
| `npm run e2e:fake-live` | 通过 |
| `npm run e2e:demo` | 通过 |
| `npm test` | 111/111 pass |
| `npm run lint` | 通过，0 error / 0 warning |
| `npm run build` | 通过，Vinext 5/5 |
| `npm run desktop:build` | 通过，Electron 43.4.0 x64 + NSIS |
| `git diff --check` | 通过；仅既有 LF→CRLF 提示 |

最终产物（取代本文旧轮次哈希）：

- `release/MuJing-Setup-0.3.4.exe`：140,739,471 bytes（134.220 MiB）；SHA-256 `8C65112DD9100D7D2FE56782FE6B516226D69E3AE6B9BD700230C6E4C2BAD9B1`；FileVersion/ProductVersion `0.3.4/0.3.4`；Authenticode `NotSigned`，Signer `none`。
- `release/win-unpacked/MuJing.exe`：225,533,440 bytes（215.085 MiB）；SHA-256 `FFAD391D9B7429470683894E3496D2F242F72691863B1839B80CDC030A97812E`；FileVersion/ProductVersion `0.3.4/0.3.4.0`；Authenticode `NotSigned`，Signer `none`。

持久证据：[E2E_REPORT.md](C:/Users/Mr.X/hermes-output/mujing-0.3.4/e2e-evidence/E2E_REPORT.md)。

诚实剩余限制：未连接真实供应商，未验证线上模型质量、实际计费与响应漂移；未把 NSIS 安装进真实用户目录；Windows 目录权限依赖用户 profile 的继承 ACL，Node mode 不是完整 Windows ACL 编辑器；安装包未正式签名且仍使用默认 Electron 图标。
