# iOS / iPadOS

当前提供两种访问远程只读展示站的形态：

1. **Capacitor 原生壳**：本目录中的 Xcode 工程，可安装到 iPhone 或 iPad。
2. **Safari 主屏幕快捷方式**：打开仓库配置的展示站后添加到主屏幕。

两者都需要联网并读取最近一次部署的脱敏只读快照，不包含本地 Python 服务，也不能导入、编辑、登录会员或调用 AI。当前地址配置为明文 HTTP；这不是完整 PWA，Service Worker、离线能力和传输完整性都需要 HTTPS。

## 原生工程

以下命令均从仓库根目录执行：

```sh
npm install
npx cap sync ios
(cd ios/App && pod install)
./ios/verify.sh
npx cap open ios
```

`npx cap sync ios` 会生成校验所需、但被 `ios/.gitignore` 排除的 Capacitor 配置。当前根 `.gitignore` 还排除了整个 `mobile-shell/`，HEAD 中没有其 `index.html`；因此全新 clone 不能独立完成这一步，必须先从受控来源恢复 `mobile-shell/index.html`，或先修复仓库跟踪策略。这是当前构建可复现性缺口。

`verify.sh` 只做工程、Pods 和资源的静态校验，不等于 Xcode 编译或真机验收。它仍需要 CocoaPods，以及带 Pillow 的 Python 环境。构建需要完整 Xcode；真机安装还需要按当前 Apple 规则配置签名。

工程目前包含限定到配置服务器 IP 的 ATS 明文例外。该例外会允许未加密流量，生产发布前必须把展示站迁到 HTTPS 并移除例外。

## 共享的移动布局

- 单列布局，侧栏改为抽屉，文献详情改为底部浮层。
- 适配安全区、移动输入框和无悬停交互。
- 这些样式来自展示站前端；原生壳本身不复制业务数据或服务端能力。

## 网页视口校验

```sh
node ios/verify-mobile.cjs https://guzilab.com
```

前置：安装 Playwright 与 Chromium。该脚本只覆盖若干移动视口的 Chromium smoke，不代表 Safari、WKWebView、安装流程或真机已经通过。

## 发布前仍需完成

- 启用 HTTPS 并移除 ATS 明文例外。
- 在 Xcode 中完成模拟器和真机回归、签名与 Archive。
- 按当前 App Store 要求核对 Bundle ID、隐私声明和开发者计划资格。
