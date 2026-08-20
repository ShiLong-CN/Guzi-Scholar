#!/bin/zsh
# Deploy the read-only web showcase to the qq2h2g server (port 80).
# Usage: ./deploy.sh [--skip-data]
set -euo pipefail

SCRIPT_DIR=${0:a:h}
REPO_ROOT=${SCRIPT_DIR:h}
APP_SRC="$REPO_ROOT/apps/desktop"
REMOTE=qq2h2g
REMOTE_HOST=82.156.152.27
REMOTE_ROOT=/home/ubuntu/my-scholar-web

echo "==> Prepare remote layout"
ssh "$REMOTE" "mkdir -p '$REMOTE_ROOT/app' '$REMOTE_ROOT/data'"

echo "==> Sync application code"
rsync -az --delete --delete-excluded --delay-updates \
  --include='/server.py' --include='/ai.py' --include='/config.py' \
  --include='/pipeline.py' --include='/layout_pipeline.py' \
  --include='/library_store.py' --include='/bibliography.py' \
  --include='/config.example.json' --include='/web' --include='/web/***' \
  --exclude='*' \
  "$APP_SRC/" "$REMOTE:$REMOTE_ROOT/app/"
rsync -az "$SCRIPT_DIR/landing.html" "$REMOTE:$REMOTE_ROOT/app/"

if [[ "${1:-}" != "--skip-data" ]]; then
  # An empty or missing source library would let --delete wipe the showcase.
  paper_count=$(find "$APP_SRC/data/jobs" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$paper_count" -lt 1 ]]; then
    echo "[abort] $APP_SRC/data/jobs 里没有文献，拒绝用空目录同步（会清空线上展示库）。" >&2
    exit 1
  fi
  echo "==> Sync library data ($paper_count papers; credentials, notes and annotations stay local)"
  # --delete-excluded also purges files a previous deploy pushed before an
  # exclusion existed; without it, retired private files linger on the host.
  # --delay-updates keeps every new file aside until the transfer finishes,
  # so an interrupted deploy cannot leave the live site half-updated.
  rsync -az --delete --delete-excluded --delay-updates \
    --filter='protect .my-scholar.lock' \
    --exclude='account.json' --exclude='.my-scholar.lock' \
    --exclude='settings.json' --exclude='library.json.bak' \
    --exclude='**/annotations.json' --exclude='**/notes.md' \
    --exclude='**/notes/**' --exclude='**/ai-highlights.json' \
    --exclude='**/upload.pdf' --exclude='**/work/**' \
    --exclude='**/layout/**' --exclude='.DS_Store' \
    "$APP_SRC/data/" "$REMOTE:$REMOTE_ROOT/data/"
fi

echo "==> Install systemd service"
ssh "$REMOTE" 'sudo tee /etc/systemd/system/my-scholar-web.service > /dev/null << "UNIT"
[Unit]
Description=Guzi Scholar read-only web showcase
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=120
StartLimitBurst=5

[Service]
User=ubuntu
WorkingDirectory=/home/ubuntu/my-scholar-web/app
Environment=MY_SCHOLAR_READONLY=1
Environment=MY_SCHOLAR_DATA_DIR=/home/ubuntu/my-scholar-web/data
Environment=MY_SCHOLAR_LANDING_FILE=/home/ubuntu/my-scholar-web/app/landing.html
ExecStart=/usr/bin/python3 /home/ubuntu/my-scholar-web/app/server.py --host 0.0.0.0 --port 80
AmbientCapabilities=CAP_NET_BIND_SERVICE
Restart=on-failure
RestartSec=3
# Defence in depth: even a logic bug cannot write outside the data root.
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/home/ubuntu/my-scholar-web/data
PrivateTmp=yes
NoNewPrivileges=yes

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload && sudo systemctl enable --now my-scholar-web && sudo systemctl restart my-scholar-web'

echo "==> Wait for service"
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  sleep 1
  if ssh "$REMOTE" 'systemctl is-active --quiet my-scholar-web'; then break; fi
  if [[ "$attempt" == 10 ]]; then
    echo "[fail] 服务未能进入 active 状态：" >&2
    ssh "$REMOTE" 'systemctl status my-scholar-web --no-pager -l | tail -20' >&2
    exit 1
  fi
done

echo "==> Health probe"
health=$(curl -sS -m 10 "http://$REMOTE_HOST/api/health") || {
  echo "[fail] 健康探针无响应。" >&2
  exit 1
}
if [[ "$health" != *'"readonly":true'* ]]; then
  echo "[fail] 服务未以只读模式运行，已停止以免公网暴露可写实例：$health" >&2
  ssh "$REMOTE" 'sudo systemctl stop my-scholar-web' || true
  exit 1
fi
echo "$health" | head -c 160
echo
echo "Deployed: http://$REMOTE_HOST/"
