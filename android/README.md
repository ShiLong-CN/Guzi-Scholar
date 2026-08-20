# Android

本目录是加载远程只读展示站的 Capacitor 原生壳，产物为 APK。它不包含本地 Python 服务或可写文献库；导入、编辑、账号会员与 AI 仍只在桌面客户端提供。

## 构建与校验

```sh
npm install
npx cap sync android
./android/build.sh          # 生成 android/dist/谷子学术-0.1.0-debug.apk
./android/verify.sh         # 静态校验包名、应用名、权限、图标和网络配置
adb install -r android/dist/谷子学术-0.1.0-debug.apk
```

以上命令从仓库根目录执行。首次构建需要先安装 Node 依赖并执行 Capacitor 同步，还需要 Android SDK（`ANDROID_HOME`，Platform 35 与对应 build-tools）和 **JDK 17-21**
（Gradle 不支持更新的 class 版本；脚本会自动在 `~/.jdks` 下寻找）。

当前根 `.gitignore` 排除了整个 `mobile-shell/`，HEAD 中没有其 `index.html`；因此全新 clone 在 `npx cap sync android` 前必须先从受控来源恢复 `mobile-shell/index.html`，或先修复仓库跟踪策略。直接运行 Gradle 不能补齐这项源文件，也不能保证生成正确的远程站配置。

## 已交付

- `com.guzi.scholar`，minSdk 23 / targetSdk 35
- 应用名与图标为谷子品牌（含 Android 自适应图标与启动图）
- 应用启动后加载仓库配置的 `https://guzilab.com` 只读展示站
- Gradle `versionName` 与构建脚本文件名统一为 `0.1.0`

移动壳只允许 HTTPS，并关闭 cleartext traffic 与 mixed content。

## 与网页版的关系

展示站读取最近一次部署的脱敏只读快照，不与桌面文献库实时同步。修改 `apps/desktop/web` 后应重新部署 `webseit/`，通常无需重建 APK。首次构建，以及修改 `capacitor.config.json`、`mobile-shell/` 或原生工程后，都应从仓库根执行 `npx cap sync android` 再重新构建。

## 后续（上架应用商店）

需要用仓库外安全保存的发布密钥签名并构建 AAB。不要把 keystore 或密码写入仓库：

```sh
keytool -genkey -v -keystore /secure/path/guzi-scholar-release.keystore -alias guzi -keyalg RSA -validity 10000
# 在 android/app/build.gradle 配置 signingConfigs 后：
./android/build.sh bundleRelease
```
