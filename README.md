# 幕境 · AI 视频创作工作台

幕境是一款 Windows 桌面视频创作应用，可以把解说文稿转换为角色设定、分镜、图片、视频、配音、时间轴和最终 MP4。

## 使用流程

1. 在“文稿”中输入或导入解说文稿，并设置比例、风格和节奏。
2. 在“角色”中上传参考图、编辑角色提示词并生成角色母版。
3. 生成并确认分镜，必要时修改画面描述。
4. 先生成全部图片，再生成对应视频。
5. 生成解说配音，在时间轴检查字幕与镜头，导出 MP4 或 `.story` 项目包。

## API 设置

点击左下角“模型与偏好设置”：

- 演示模式无需 API，可以完成分镜、示意画面和 MP4 流程验证。
- 真实模式支持 OpenAI，以及火山方舟 Seedream / Seedance。
- OpenAI 默认使用 `gpt-5.6`、`gpt-image-2`、`sora-2` 和 `gpt-4o-mini-tts`。
- Seedream / Seedance 需要填写火山方舟 API Key、服务地址和已开通的模型 ID。

API Key 由 Electron 主进程使用 Windows `safeStorage` 加密保存，不会写入浏览器存储或导出的项目包。

## 开发与打包

```bash
npm install
npm run dev
npm test
npm run desktop:build
```

Windows 安装程序输出到 `release/MuJing-Setup-<version>.exe`。发布给其他用户前，应配置正式的 Windows 代码签名证书。
