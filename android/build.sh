#!/bin/zsh
# Build the Android app. Requires the Android SDK and a JDK 17-21 (Gradle
# rejects newer class files); the script finds a compatible JDK itself.
set -euo pipefail

SCRIPT_DIR=${0:a:h}
cd "$SCRIPT_DIR"

if [[ -z "${ANDROID_HOME:-}" ]]; then
  export ANDROID_HOME="$HOME/Library/Android/sdk"
fi
[[ -d "$ANDROID_HOME" ]] || { echo "[abort] 未找到 Android SDK（设置 ANDROID_HOME）" >&2; exit 1; }
[[ -f local.properties ]] || echo "sdk.dir=$ANDROID_HOME" > local.properties

if [[ -z "${JAVA_HOME:-}" || ! -x "${JAVA_HOME:-}/bin/java" ]]; then
  for candidate in "$HOME"/.jdks/jdk-21*/Contents/Home "$HOME"/.jdks/jdk-17*/Contents/Home; do
    [[ -x "$candidate/bin/java" ]] && export JAVA_HOME="$candidate" && break
  done
fi
[[ -x "${JAVA_HOME:-}/bin/java" ]] || { echo "[abort] 需要 JDK 17-21，未找到（设置 JAVA_HOME）" >&2; exit 1; }
echo "==> JDK: $("$JAVA_HOME/bin/java" -version 2>&1 | head -1)"

target=${1:-assembleDebug}
echo "==> Gradle $target"
./gradlew "$target"

mkdir -p dist
if [[ "$target" == "assembleDebug" ]]; then
  cp app/build/outputs/apk/debug/app-debug.apk "dist/谷子学术-0.1.0-debug.apk"
  echo "APK: $SCRIPT_DIR/dist/谷子学术-0.1.0-debug.apk"
fi
