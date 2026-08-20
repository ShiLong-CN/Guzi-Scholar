#!/bin/zsh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"

if [ ! -f "$SCRIPT_DIR/package.json" ]; then
  print -u2 "找不到 My Scholar 项目目录：$SCRIPT_DIR"
  exit 1
fi

NODE_BIN="${MY_SCHOLAR_NODE:-}"
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "$candidate" ]; then
      NODE_BIN="$candidate"
      break
    fi
  done
fi
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  NODE_BIN=$(command -v node || true)
fi
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  print -u2 "没有找到 Node.js。请先安装 Node.js，再重新双击此文件。"
  exit 1
fi

exec "$NODE_BIN" "$SCRIPT_DIR/electron/launcher.cjs"
