#!/bin/zsh
# Assert the Xcode project is complete and correctly configured. Building it
# needs full Xcode; this runs without it so the project can be checked on any
# machine.
set -euo pipefail
SCRIPT_DIR=${0:a:h}
APP="$SCRIPT_DIR/App"

fail() { echo "  FAIL $1" >&2; exit 1; }

echo "==> Project structure"
for f in App.xcworkspace/contents.xcworkspacedata App.xcodeproj/project.pbxproj \
         Podfile Podfile.lock Pods/Pods.xcodeproj/project.pbxproj \
         App/AppDelegate.swift App/Info.plist App/capacitor.config.json \
         App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png; do
  [[ -e "$APP/$f" ]] || fail "缺少 $f"
done
echo "  ok"

echo "==> CocoaPods integrated"
grep -q 'Capacitor' "$APP/Podfile.lock" || fail "Podfile.lock 未包含 Capacitor"
diff -q "$APP/Podfile.lock" "$APP/Pods/Manifest.lock" >/dev/null || fail "Pods 与 Podfile.lock 不同步（运行 pod install）"
echo "  ok ($(grep -c '  - ' "$APP/Podfile.lock" | head -1) pods)"

echo "==> App identity"
plutil -lint "$APP/App/Info.plist" >/dev/null || fail "Info.plist 无效"
name=$(/usr/libexec/PlistBuddy -c "Print :CFBundleDisplayName" "$APP/App/Info.plist" 2>/dev/null || echo "")
[[ "$name" == "谷子学术" ]] || fail "显示名为 '$name'"
grep -q '"appId": "com.guzi.scholar"' "$SCRIPT_DIR/../capacitor.config.json" || fail "appId"
echo "  ok ($name)"

echo "==> HTTPS transport policy"
/usr/libexec/PlistBuddy -c "Print :NSAppTransportSecurity:NSAllowsArbitraryLoads" "$APP/App/Info.plist" >/dev/null 2>&1 \
  && fail "不应全局关闭 ATS"
grep -q '"url": "https://guzilab.com"' "$SCRIPT_DIR/../capacitor.config.json" || fail "HTTPS server url"
echo "  ok"

echo "==> App icon"
python3 - "$APP/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png" <<'PY' || fail "图标不符合要求"
import sys
from PIL import Image
image = Image.open(sys.argv[1])
assert image.size == (1024, 1024), image.size
assert image.mode == 'RGB', image.mode  # App Store rejects alpha
PY
echo "  ok (1024x1024, no alpha)"

echo
if xcodebuild -version >/dev/null 2>&1; then
  echo "Xcode 可用，可执行：npx cap open ios 然后 Product > Run"
else
  echo "工程校验通过。构建需要安装完整 Xcode（当前只有 Command Line Tools）："
  echo "  1. App Store 安装 Xcode"
  echo "  2. sudo xcode-select -s /Applications/Xcode.app/Contents/Developer"
  echo "  3. cd $SCRIPT_DIR/App && pod install"
  echo "  4. npx cap open ios   # 打开 App.xcworkspace 后直接 Run"
fi
