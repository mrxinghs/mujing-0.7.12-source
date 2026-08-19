# 幕境 0.3.6 执行结果

日期：2026-08-16（America/Los_Angeles）

## 结论

已按火山引擎 Seedance 2.5 官方契约完成付费视频提交修正、HTTP 拒绝与不确定提交分流、renderer 风险显示修正和回归覆盖，并成功生成 NSIS 0.3.6 安装器。

本次未发送任何真实生成 POST；所有 Provider 网络测试均使用进程内 `fetch` stub。未修改 Windows AppData、用户媒体或真实付费任务 journal，未启动或安装生成的安装器，未关闭现有应用，未创建 Git commit。

## 官方契约依据

- 火山引擎官方文档：[Seedance 2.5 API 文档](https://docs.volcengine.com/docs/82379/2298881?lang=zh)
- 采用模型契约：`doubao-seedance-2-5-260628`
- `content[0].text` 仅包含干净提示词，不再附加 `--dur`、`--duration`、`--ratio` 等旧 token。
- 请求 JSON 顶层发送 `ratio` 和 `duration`。
- UI 比例映射限定为官方支持的 `9:16` / `16:9`；时长继续限制为当前产品边界 4–12 秒，没有扩展到 15 秒。
- 创建成功的任务 ID 只读取响应顶层 `id`；嵌套 `data.id` 等字段不作为成功依据。

## 实现结果

### Provider 边界

- 新增结构化 `ProviderHttpError`：固定 `name`、`code=PROVIDER_HTTP_REJECTED`、有效 HTTP `status` 和 `definitiveRejection=true`。
- HTTP 非 2xx 的服务商 body 会在有界读取后直接丢弃；面向 renderer 的错误只包含安全、固定文案和 HTTP 状态，不包含服务商原始 message、请求 body、API key、prompt 或 base64。
- 2xx 任务失败响应同样不再透传 `job.error.message`。
- 传输异常、2xx 畸形响应或 2xx 缺顶层 `id` 不会伪装成 HTTP 拒绝。

### 付费任务 journal

- HTTP 非 2xx 提交持久化为 `status: rejected`、`failure: provider-http-rejected` 和数字 `httpStatus`，不会误记为 `unknown`。
- 明确 HTTP 拒绝后允许普通重试，不要求“未知受理”付费重提授权。
- 传输丢失与 2xx 缺顶层 `id` 仍持久化为 `unknown`，普通重试保持锁定，只能经过主进程原生一次性付费重提授权。
- 对已有 `unknown` 的后续尝试使用独立 journal 条目；后续 HTTP 拒绝不会覆盖、迁移或清理旧 `unknown`。
- 兼容原 version 1 journal；没有自动迁移或重写旧记录。

### Renderer

- journal 恢复按镜头聚合所有尝试，而不是只看最后一条：已知 task ID 可以继续轮询，同时旧 `unknown` 风险仍被保留并显示。
- 明确 HTTP 拒绝显示安全错误且 `videoSubmissionRisk=false`；普通“单独重试视频”路径保持可用。
- 未知受理错误才设置 `videoSubmissionRisk=true`。
- 显式重提失败不再使用 `!replacementJobId` 粗略推断风险，也不会意外丢失原 task ID/provider。

## TDD 证据

1. 先新增 `tests/seedance-provider-http.test.mjs` 并单独运行。修正测试夹具后的 RED 为 7 项中 5 项失败，失败点分别对应旧 prompt token、缺少结构化 HTTP 错误、journal 误记 unknown、旧 unknown 被覆盖、renderer 缺少风险分类。
2. 补充“2xx failed task 不得泄露 Provider message”测试后，该测试先单独 RED，原始 secret/prompt/base64 文本被证明会泄露。
3. 实现后该文件 8/8 GREEN。
4. 既有付费边界、journal、workflow、UX、媒体输入与路由聚焦回归 62/62 GREEN。
5. 最终全量测试 167/167 GREEN。

## 最终验证

- `npm test`：通过，167 tests / 167 pass / 0 fail。
- `npm run lint`：通过，0 error。
- `npm run build`：通过。
- `npm run desktop:build`：通过；Electron Builder 26.15.3 成功生成 Windows x64 NSIS。
- `git diff --check`：通过；只有 Git 的 LF→CRLF 工作树提示，没有空白错误。
- 定向泄露/旧 token 扫描：生产代码中未发现 `job?.error?.message`、`detail?.error?.message` 或旧 `--dur` / `--duration` / `--ratio` 拼接；旧 token 只存在于负向断言测试。
- `npm audit --omit=dev --json`：生产依赖 0 vulnerability。
- 完整 `npm audit --json`：0 critical、13 high、6 moderate、1 low，共 20 项，均来自当前锁定的开发/构建工具链。按本任务边界未修改依赖版本；主要可升级链涉及 Vite、Vinext、Cloudflare/Wrangler、Drizzle Kit 及其传递依赖。

## NSIS 产物

- 文件：`release/MuJing-Setup-0.3.6.exe`
- 大小：140,751,339 bytes
- SHA-256：`2B23C2550D158C9AAF3A1398BF762D6FC4D1C48AD2A241AB6E2D9E4531FE07D1`
- 生成时间：2026-08-16 00:23:45 -07:00
- Block map：`release/MuJing-Setup-0.3.6.exe.blockmap`

## 边界说明

- 仓库进入本次续做前已有大量未提交修改和未跟踪文件；均按用户工作保留，没有 reset、checkout、删除或提交。
- 构建只更新仓库内 `dist/` 与 `release/` 产物；测试只使用系统临时目录中的隔离夹具。
- 安装器使用 Electron 默认图标，构建日志明确提示未配置应用图标；这不影响本次功能与安全目标。
