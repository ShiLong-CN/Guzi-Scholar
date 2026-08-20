#!/bin/sh
# Forward a local OpenAI-compatible port through an SSH jump host.
# Connection details must be supplied through environment variables.
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
proxy="$script_dir/lsl-proxy-command.sh"
local_port=${MY_SCHOLAR_AI_LOCAL_PORT:-3000}
remote_port=${MY_SCHOLAR_AI_REMOTE_PORT:-3000}
lsl_host=${MY_SCHOLAR_LSL_HOST:-}
lsl_port=${MY_SCHOLAR_LSL_PORT:-22}
lsl_user=${MY_SCHOLAR_LSL_USER:-}
identity_file=${MY_SCHOLAR_LSL_IDENTITY_FILE:-}

if [ -z "$lsl_host" ] || [ -z "$lsl_user" ] || [ -z "$identity_file" ]; then
  echo "请设置 MY_SCHOLAR_LSL_HOST、MY_SCHOLAR_LSL_USER 和 MY_SCHOLAR_LSL_IDENTITY_FILE。" >&2
  exit 2
fi

case "$local_port:$remote_port:$lsl_port" in
  *[!0-9:]*|*:|:*:) echo "端口必须是数字。" >&2; exit 2 ;;
esac

exec ssh -4 -N -T \
  -o BatchMode=yes \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -o IdentitiesOnly=yes \
  -i "$identity_file" \
  -o "ProxyCommand=$proxy %h %p" \
  -p "$lsl_port" \
  -L "127.0.0.1:${local_port}:127.0.0.1:${remote_port}" \
  "$lsl_user@$lsl_host"
