# macOS 平台层

macOS 与 Windows 共用 `apps/desktop/` 的 Electron、Web 和 Python 业务代码。

本目录预留 macOS 专属的签名、公证、图标和发布配置。当前开发启动入口仍是：

```sh
npm run desktop:dev
```

macOS Apple Silicon 内部包由 `apps/desktop` 的 `dist:mac:internal` 负责构建；正式发布需要 Developer ID 和 Apple 公证凭据。

CI 使用 OpenDataLoader PDF CLI `v2.5.1`，下载后会校验 ZIP 和 JAR 的 SHA-256，再交给 `prepare-mac-release.sh`。这一步不依赖仓库外的本地 `opendataloader-pdf` checkout。
