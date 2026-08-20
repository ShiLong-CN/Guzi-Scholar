#!/bin/zsh
# Put the showcase behind HTTPS so Android/Chromium will install it as an app.
#
# KNOWN BLOCKER on this host (verified 2026-08): the server sits in Tencent
# Cloud Beijing, where any domain without an ICP filing is intercepted — a
# request carrying such a Host header gets DNSPod's block page (HTTP 566)
# instead of our service, so the ACME challenge can never succeed. Free
# IP-based names (sslip.io, nip.io) are domains too and are blocked the same
# way. HTTPS therefore needs one of:
#   (a) an ICP-filed domain pointed at this server, or
#   (b) moving the showcase to a Hong Kong / overseas node (no filing), or
#   (c) an outbound tunnel that terminates TLS elsewhere.
# The script refuses to run until the chosen hostname actually serves our
# content, so it cannot leave the site redirecting into a block page again.
#
# Prerequisites:
#   1. TCP 443 open in the cloud firewall.
#   2. A hostname resolving to this server that is NOT intercepted.
#
# Usage: ./enable-https.sh <hostname>
set -euo pipefail

REMOTE=qq2h2g
REMOTE_HOST=82.156.152.27
HOSTNAME_ARG=${1:-82-156-152-27.sslip.io}

echo "==> Preflight: is 443 reachable?"
if ! nc -z -w 5 "$REMOTE_HOST" 443 2>/dev/null; then
  cat >&2 <<EOF
[abort] TCP 443 不可达。请先在腾讯云控制台放行 443 端口：
  轻量应用服务器 → 实例 → 防火墙 → 添加规则 → TCP / 443 / 来源 0.0.0.0/0
EOF
  exit 1
fi

echo "==> Preflight: does $HOSTNAME_ARG resolve to $REMOTE_HOST?"
resolved=$(dig +short "$HOSTNAME_ARG" | tail -1)
if [[ "$resolved" != "$REMOTE_HOST" ]]; then
  echo "[abort] $HOSTNAME_ARG 解析到 '$resolved'，期望 $REMOTE_HOST。" >&2
  exit 1
fi

echo "==> Preflight: is the hostname intercepted by ICP filtering?"
probe=$(curl -sS -m 10 "http://$HOSTNAME_ARG/api/health" 2>/dev/null || true)
if [[ "$probe" != *'"service":"my-scholar"'* ]]; then
  cat >&2 <<EOF
[abort] http://$HOSTNAME_ARG/api/health 没有返回本服务，收到：
${probe:0:200}
未备案域名会被大陆机房拦截（DNSPod webblock），此时无法签发证书。
请改用已备案域名，或把展示站迁到香港/海外节点后重试。
EOF
  exit 1
fi

echo "==> Install Caddy (automatic Let's Encrypt certificates)"
ssh "$REMOTE" 'command -v caddy >/dev/null 2>&1 || {
  sudo apt-get update -qq
  sudo apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -qq && sudo apt-get install -y -qq caddy
}'

echo "==> Move the app to 8081 so Caddy can own 80/443"
ssh "$REMOTE" "sudo sed -i 's/--port 80/--port 8081/' /etc/systemd/system/my-scholar-web.service
sudo sed -i '/AmbientCapabilities=CAP_NET_BIND_SERVICE/d' /etc/systemd/system/my-scholar-web.service
sudo systemctl daemon-reload && sudo systemctl restart my-scholar-web"

echo "==> Configure Caddy"
ssh "$REMOTE" "sudo tee /etc/caddy/Caddyfile > /dev/null << CADDY
$HOSTNAME_ARG {
	encode zstd gzip
	reverse_proxy 127.0.0.1:8081
}

http://$REMOTE_HOST {
	redir https://$HOSTNAME_ARG{uri} permanent
}
CADDY
sudo systemctl reload caddy || sudo systemctl restart caddy"

echo "==> Wait for the certificate"
for attempt in $(seq 1 30); do
  sleep 4
  if curl -sS -m 8 "https://$HOSTNAME_ARG/api/health" >/dev/null 2>&1; then
    echo
    echo "HTTPS ready: https://$HOSTNAME_ARG/"
    echo "Android Chrome 现在会提供「安装应用」；iOS Safari 的「添加到主屏幕」同样可用。"
    exit 0
  fi
  printf '.'
done

echo >&2
echo "[fail] 证书签发超时，检查：ssh $REMOTE 'sudo journalctl -u caddy -n 40 --no-pager'" >&2
exit 1
