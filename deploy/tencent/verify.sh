#!/usr/bin/env bash
set -Eeuo pipefail

readonly REMOTE=tencent
readonly REMOTE_HOST=82.156.152.27
if [[ $# -ne 0 ]]; then
  echo "usage: $0" >&2
  exit 64
fi

CONFIGURED_HOST=$(ssh -G "$REMOTE" 2>/dev/null | awk '$1 == "hostname" { print $2; exit }')
if [[ "$CONFIGURED_HOST" != "$REMOTE_HOST" ]]; then
  echo "[verify] ssh $REMOTE resolves to '$CONFIGURED_HOST', expected $REMOTE_HOST" >&2
  exit 78
fi

ssh "$REMOTE" bash -s <<'REMOTE'
set -Eeuo pipefail
for UNIT in guzi-scholar-account.service guzi-scholar-ai.service guzi-scholar-showcase.service guzi-scholar-account-backup.timer caddy.service; do
  systemctl is-active --quiet "$UNIT" || {
    echo "[verify] inactive service: $UNIT" >&2
    exit 69
  }
done
[[ $(caddy version | awk '{print $1}') == v2.11.4 ]]
sudo -n caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null

[[ $(sudo -n stat -c '%a:%U:%G' /var/lib/guzi-scholar/account) == 700:guzi-account:guzi-account ]]
[[ $(sudo -n stat -c '%a:%U:%G' /var/lib/guzi-scholar/account/users.db) == 600:guzi-account:guzi-account ]]
[[ $(sudo -n stat -c '%a:%U:%G' /var/backups/guzi-scholar/account) == 700:guzi-account:guzi-account ]]
[[ $(sudo -n stat -c '%a:%U:%G' /etc/guzi-scholar/account.env) == 600:root:root ]]
[[ $(sudo -n stat -c '%a:%U:%G' /etc/guzi-scholar/ai.tokens.json) == 640:root:guzi-account ]]
sudo -n /usr/local/sbin/guzi-scholar-db-verify /var/lib/guzi-scholar/account/users.db
sudo -n /usr/local/sbin/guzi-scholar-ai-config-verify /etc/guzi-scholar/ai.tokens.json
AI_PROBE=$(sudo -n -u guzi-account env \
  MY_SCHOLAR_DEVELOPER_TOKENS_FILE=/etc/guzi-scholar/ai.tokens.json \
  /usr/bin/python3 -B /opt/guzi-scholar/current/account/ai_gateway.py probe --timeout 20)
/usr/bin/python3 -c '
import json, sys
payload = json.loads(sys.stdin.read())
assert payload.get("ok") is True
assert all(payload.get("services", {}).get(name, {}).get("ok") is True for name in ("translation", "chat"))
' <<<"$AI_PROBE"

for SPEC in '8478 127.0.0.1:8478' '8081 127.0.0.1:8081'; do
  set -- $SPEC
  PORT=$1
  EXPECTED=$2
  SOCKETS=$(sudo -n ss -H -ltn "sport = :$PORT")
  [[ "$SOCKETS" == *"$EXPECTED"* ]] || {
    echo "[verify] port $PORT is not bound to $EXPECTED" >&2
    exit 69
  }
  [[ "$SOCKETS" != *"0.0.0.0:$PORT"* && "$SOCKETS" != *"[::]:$PORT"* ]] || {
    echo "[verify] port $PORT is exposed publicly" >&2
    exit 78
  }
done
AI_SOCKETS=$(sudo -n ss -H -ltn 'sport = :8480')
[[ "$AI_SOCKETS" == *'127.0.0.1:8480'* && "$AI_SOCKETS" != *'0.0.0.0:8480'* && "$AI_SOCKETS" != *'[::]:8480'* ]]

curl --fail --silent --show-error --max-time 10 http://127.0.0.1:8478/api/health >/dev/null
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:8081/api/health >/dev/null

python3 - /opt/guzi-scholar/current/updates/macos/arm64/beta.json /opt/guzi-scholar/current/updates/macos/arm64 <<'PY'
import hashlib
import json
import pathlib
import re
import sys
import urllib.parse

manifest = pathlib.Path(sys.argv[1])
artifact_root = pathlib.Path(sys.argv[2]).resolve(strict=True)
payload = json.loads(manifest.read_text(encoding="utf-8"))
url = urllib.parse.urlsplit(payload.get("download_url", ""))
name = pathlib.PurePosixPath(url.path).name
assert url.scheme == "https" and url.netloc == "82.156.152.27"
assert pathlib.PurePosixPath(url.path).parent == pathlib.PurePosixPath("/updates/macos/arm64")
assert not url.query and not url.fragment
assert re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.dmg", name)
assert re.fullmatch(r"[0-9a-f]{64}", payload.get("sha256", ""))
artifact = artifact_root / name
assert artifact.is_file() and artifact.resolve(strict=True).parent == artifact_root
assert artifact.stat().st_size > 0
digest = hashlib.sha256()
with artifact.open("rb") as handle:
    for chunk in iter(lambda: handle.read(1024 * 1024), b""):
        digest.update(chunk)
assert digest.hexdigest() == payload["sha256"]
assert (artifact.stat().st_mode & 0o777) == 0o444
PY

LATEST=$(sudo -n find /var/backups/guzi-scholar/account -maxdepth 1 -type f -name 'users-*.sqlite3' -printf '%T@ %p\n' | sort -rn | head -n 1 | cut -d' ' -f2-)
[[ -n "$LATEST" ]]
[[ $(sudo -n stat -c '%a:%U:%G' "$LATEST") == 600:guzi-account:guzi-account ]]
[[ $(sudo -n stat -c '%a:%U:%G' "$LATEST.sha256") == 600:guzi-account:guzi-account ]]
sudo -n sha256sum -c "$LATEST.sha256" >/dev/null
sudo -n /usr/local/sbin/guzi-scholar-db-verify "$LATEST" >/dev/null
echo "[verify] remote services, permissions, listeners, live database and latest backup are valid"
REMOTE

for SPEC in '8081 /api/health' '8478 /api/health' '8480 /health'; do
  set -- $SPEC
  PORT=$1
  PATHNAME=$2
  if curl --noproxy '*' --silent --show-error --connect-timeout 3 --max-time 5 \
    --output /dev/null "http://$REMOTE_HOST:$PORT$PATHNAME" 2>/dev/null; then
    echo "[verify] internal port $PORT is reachable from the public internet" >&2
    exit 78
  fi
done

HTTPS_LOCAL_READY=0
for ATTEMPT in $(seq 1 40); do
  if ssh "$REMOTE" curl --resolve "$REMOTE_HOST:443:127.0.0.1" \
    --fail --silent --show-error --connect-timeout 3 --max-time 5 \
    "https://$REMOTE_HOST/api/health" >/dev/null 2>&1; then
    HTTPS_LOCAL_READY=1
    break
  fi
  sleep 2
done
if [[ $HTTPS_LOCAL_READY -ne 1 ]]; then
  echo "[verify] Caddy did not load a locally usable IP certificate" >&2
  exit 69
fi
if ! ACCOUNT_HEALTH=$(curl --noproxy '*' --fail --silent --show-error \
  --connect-timeout 5 --max-time 15 "https://$REMOTE_HOST/api/health"); then
  echo "[verify] public TCP 443 or HTTPS account health is unreachable" >&2
  exit 69
fi
/usr/bin/python3 -c '
import json, sys
payload = json.loads(sys.stdin.read())
assert payload.get("ok") is True
assert payload.get("service") == "my-scholar-account"
' <<<"$ACCOUNT_HEALTH"
SHOWCASE_HEALTH=$(curl --noproxy '*' --fail --silent --show-error --max-time 10 "https://$REMOTE_HOST/_health/showcase")
/usr/bin/python3 -c '
import json, sys
payload = json.loads(sys.stdin.read())
assert payload.get("readonly") is True
' <<<"$SHOWCASE_HEALTH"
curl --noproxy '*' --fail --silent --show-error --max-time 15 "https://$REMOTE_HOST/ai/health" >/dev/null
UPDATE_MANIFEST=$(curl --noproxy '*' --fail --silent --show-error --max-time 10 "https://$REMOTE_HOST/updates/macos/arm64/beta.json")
/usr/bin/python3 -c '
import json, sys
payload = json.loads(sys.stdin.read())
assert payload.get("schema") == 1
assert payload.get("platform") == "darwin"
assert payload.get("arch") == "arm64"
assert payload.get("channel") == "beta"
assert isinstance(payload.get("version"), str) and payload["version"]
assert payload.get("download_url") == "https://82.156.152.27/updates/macos/arm64/Guzi-Scholar-0.1.0-arm64.dmg"
assert isinstance(payload.get("sha256"), str) and len(payload["sha256"]) == 64
' <<<"$UPDATE_MANIFEST"
UPDATE_DOWNLOAD_URL=$(/usr/bin/python3 -c '
import json, sys
print(json.loads(sys.stdin.read())["download_url"])
' <<<"$UPDATE_MANIFEST")
curl --noproxy '*' --fail --silent --show-error --head --max-time 15 "$UPDATE_DOWNLOAD_URL" >/dev/null

CERT_FILE=$(mktemp /tmp/guzi-scholar-cert.XXXXXX)
cleanup_cert() {
  [[ ! -e "$CERT_FILE" ]] || unlink -- "$CERT_FILE"
}
trap cleanup_cert EXIT
openssl s_client -connect "$REMOTE_HOST:443" -servername "$REMOTE_HOST" </dev/null 2>/dev/null | openssl x509 -outform PEM >"$CERT_FILE"
openssl x509 -in "$CERT_FILE" -checkend 432000 -noout >/dev/null
if openssl x509 -in "$CERT_FILE" -checkend 691200 -noout >/dev/null; then
  echo "[verify] certificate lifetime exceeds the expected short-lived profile" >&2
  exit 78
fi
openssl x509 -in "$CERT_FILE" -text -noout | grep -F "IP Address:$REMOTE_HOST" >/dev/null

echo "[verify] HTTPS, IP SAN, short-lived certificate, account API, showcase and exposure checks passed"
