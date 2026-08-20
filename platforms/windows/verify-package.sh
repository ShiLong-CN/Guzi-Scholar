#!/bin/zsh
# Verify a built Windows package can actually run: Python must be able to read
# server.py from a real path (asar would break this) and the bundle must carry
# every module the server imports, with no credentials or user data inside.
set -euo pipefail

SCRIPT_DIR=${0:a:h}
APP="$SCRIPT_DIR/dist/win-unpacked/resources/app"

[[ -d "$APP" ]] || { echo "[abort] 未找到构建产物，请先运行 ./build.sh" >&2; exit 1; }

echo "==> Required files present"
for f in server.py ai.py pipeline.py layout_pipeline.py library_store.py bibliography.py config.py \
         electron/main.cjs electron/preload.cjs electron/assets/icon.ico \
         web/index.html web/app.js web/styles.css web/sw.js web/manifest.webmanifest; do
  [[ -f "$APP/$f" ]] || { echo "  MISSING $f" >&2; exit 1; }
done
echo "  ok ($(find "$APP" -type f | wc -l | tr -d ' ') files)"

echo "==> Nothing private shipped"
for f in developer.tokens.json config.local.json data tests docs; do
  [[ -e "$APP/$f" ]] && { echo "  LEAKED $f" >&2; exit 1; }
done
echo "  ok"

echo "==> Server boots from the packaged layout"
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
MY_SCHOLAR_DATA_DIR="$scratch/library" /usr/bin/python3 "$APP/server.py" --host 127.0.0.1 --port 0 > "$scratch/boot.log" 2>&1 &
server_pid=$!
trap 'kill $server_pid 2>/dev/null; rm -rf "$scratch"' EXIT
for _ in $(seq 1 20); do
  sleep 0.5
  port=$(grep -o '127.0.0.1:[0-9]*' "$scratch/boot.log" 2>/dev/null | head -1 | cut -d: -f2)
  [[ -n "${port:-}" ]] && break
done
[[ -n "${port:-}" ]] || { echo "  服务未启动：" >&2; tail -20 "$scratch/boot.log" >&2; exit 1; }
health=$(curl -sS -m 8 "http://127.0.0.1:$port/api/health")
[[ "$health" == *'"ok":true'* ]] || { echo "  健康检查失败：$health" >&2; exit 1; }
curl -sS -o /dev/null -m 8 "http://127.0.0.1:$port/web/app.js"
echo "  ok (port $port)"

echo
echo "Package verified. 仍需 Windows 实机确认：安装向导、快捷方式、Python 探测、PDF 导入。"
