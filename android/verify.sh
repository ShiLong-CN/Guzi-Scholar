#!/bin/zsh
# Assert the built APK is installable and configured for this deployment.
set -euo pipefail
SCRIPT_DIR=${0:a:h}
APK=$(ls "$SCRIPT_DIR"/dist/*.apk 2>/dev/null | head -1)
[[ -n "$APK" ]] || { echo "[abort] 未找到 APK，请先运行 ./build.sh" >&2; exit 1; }

ANDROID_HOME=${ANDROID_HOME:-$HOME/Library/Android/sdk}
AAPT=$(ls "$ANDROID_HOME"/build-tools/*/aapt2 2>/dev/null | tail -1)
[[ -n "$AAPT" ]] || { echo "[abort] 未找到 aapt2" >&2; exit 1; }

badging=$("$AAPT" dump badging "$APK")
manifest=$("$AAPT" dump xmltree "$APK" --file AndroidManifest.xml)

fail() { echo "  FAIL $1" >&2; exit 1; }
[[ "$badging" == *"package: name='com.guzi.scholar'"* ]] || fail "package id"
[[ "$badging" == *"application-label:'谷子学术'"* ]] || fail "app label"
[[ "$badging" == *"android.permission.INTERNET"* ]] || fail "INTERNET permission"
[[ "$badging" == *"application-icon-640:'res/mipmap-anydpi-v26/ic_launcher.xml'"* ]] || fail "adaptive icon"
[[ "$manifest" != *"usesCleartextTraffic"*"=true"* ]] || fail "cleartext traffic must stay disabled"
grep -q '"url": "https://guzilab.com"' "$SCRIPT_DIR/../capacitor.config.json" || fail "HTTPS server url"

echo "  ok  $(basename "$APK") ($(du -h "$APK" | cut -f1))"
echo "$badging" | grep -E "^(package|sdkVersion|targetSdkVersion)" | sed 's/^/  /'
echo
echo "安装到已连接设备：adb install -r \"$APK\""
