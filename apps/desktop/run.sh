#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PYTHON_BIN=""
for candidate in "${MY_SCHOLAR_PYTHON:-}" /opt/anaconda3/bin/python3 /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3 "$(command -v python3 2>/dev/null || true)"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ] && "$candidate" -c 'import hashlib, ssl, sqlite3, sys, urllib.request; assert sys.version_info >= (3, 9); assert hasattr(hashlib, "scrypt")' >/dev/null 2>&1; then
    PYTHON_BIN="$candidate"
    break
  fi
done
if [ -z "$PYTHON_BIN" ]; then
  echo "没有找到具备 hashlib.scrypt、ssl、sqlite3 和网络标准库的 Python 3.9+。" >&2
  exit 1
fi
exec "$PYTHON_BIN" "$SCRIPT_DIR/server.py" "$@"
