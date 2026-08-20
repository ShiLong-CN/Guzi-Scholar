# 谷子学术（Guzi Scholar）

谷子学术是一个本地优先的学术 PDF 阅读器：把论文转换为连续、可检索的阅读页面，并在同一个桌面应用中提供文献管理、翻译、标注、笔记和文章助手。

项目现在面向开源桌面发行，目标平台是 macOS 和 Windows。论文、译文、笔记、标注、设置和 AI 配置默认保存在本机；AI 服务由用户自行填写 OpenAI-compatible API 地址、密钥和模型。

English documentation is coming soon. See [README.en.md](README.en.md) for the current English placeholder.

## 功能

- 导入 PDF，并根据本地转换工具链生成结构化阅读页面
- 文献库、文件夹、自定义属性、阅读状态和关系图谱
- 原文、译文、笔记、标注和图片资产保存在本机
- 选区翻译、全文翻译、文章问答、阅读重点和表格复核
- macOS 与 Windows 共用同一套桌面应用代码
- macOS 与 Windows 使用同一套源码和独立的平台打包层

## 下载

前往 [Releases](https://github.com/ShiLong-CN/guzi-scholar/releases) 下载对应平台的安装包：

| 平台 | 产物 | 当前状态 |
| --- | --- | --- |
| macOS Apple Silicon | `.dmg` | 首要支持平台 |
| Windows x64 | NSIS `.exe` | 等待实机验证 |
| Windows x64 | 便携版 `.zip` | 等待实机验证 |

macOS 安装包内置 Python、Java 和 OpenDataLoader 运行时。Windows 开发版当前需要 Python 3.9 或更高版本，正式安装包将在实机验证后发布。

## 本地开发

```sh
npm ci
npm --prefix apps/desktop ci
npm run desktop:dev
```

常用命令：

```sh
npm run desktop:check:syntax
npm run desktop:check
npm run build:mac
npm run build:windows
npm run verify:windows
```

Windows 开发启动器位于 `platforms/windows/run-guzi-scholar.cmd`。完整的桌面服务、前端和测试代码位于 `apps/desktop/`。

macOS Release workflow 会自动准备 Temurin JDK 21、Python 3.11、`certifi`、PyInstaller，并下载固定版本的 OpenDataLoader CLI；正式签名和公证仍需要 GitHub Actions 中配置 Apple Developer ID 与公证凭据。

## 项目结构

```text
apps/desktop/
├── electron/       # Electron 主进程、预加载、启动器和桌面 IPC
├── web/            # 阅读器、文献库、设置页和前端资源
├── *.py            # 本地 HTTP 服务、文献库、转换和 AI 适配器
├── scripts/        # 桌面构建、运行时准备和校验脚本
└── tests/          # Python、JavaScript 和桌面流程测试

platforms/
├── windows/        # Windows 安装器、便携包、启动和验收配置
└── macos/          # macOS 发布配置预留目录

android/ ios/       # 当前保留的移动展示壳，暂不参与桌面发行
webseit/             # 只读展示站资源和部署脚本
deploy/              # 私有部署与运维脚本
```

平台层只负责图标、安装器、Python 探测、进程终止、签名和发布配置；业务逻辑、渲染器和本地服务由 `apps/desktop` 共享。

## 数据与隐私

默认情况下，PDF、译文、笔记、标注和 AI 配置只写入当前设备。启用在线元数据检索时，论文标识符或元数据候选会发送到相应公共服务；使用翻译或文章助手时，选中的文本或文章上下文会发送到用户配置的 AI 服务。

不要把真实 API Key、用户数据、`data/`、`developer.tokens.json` 或本地构建产物提交到 Git。本项目自有代码按 [Apache License 2.0](LICENSE) 授权，发布衍生版本时请同时遵守 `NOTICE.md`、第三方依赖、字体、图标和论文内容的授权条款。

## 贡献

欢迎通过 Issue 和 Pull Request 反馈问题、提交适配和改进。涉及平台打包的改动请同时说明目标系统、架构、安装方式和验证结果。
