# 幕境桌面版

桌面版使用 Electron 启动内置的 Vinext 应用服务，不依赖外部浏览器或单独安装 Node.js。FFmpeg 会随安装包一起分发，用于合成镜头、配音和字幕并导出 MP4；API Key 使用 Windows 安全存储加密。

- `npm run desktop:dev`：构建后启动桌面应用。
- `npm run desktop:build`：生成 Windows NSIS 安装程序。
- `npm run desktop:portable`：生成 Windows 便携版本。

打包输出位于 `release/`。发布给其他用户前，应配置正式的 Windows 代码签名证书。
