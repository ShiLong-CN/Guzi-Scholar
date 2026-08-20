#!/bin/sh
# OpenSSH ProxyCommand used when the local Mac must reach a service through a jump host.
# A multi-homed jump host may need nc bound to its route-selected address; this
# avoids macOS returning EADDRNOTAVAIL for the otherwise valid TCP destination.
set -eu

host=${1:-}
port=${2:-}
case "$host" in
  ''|*[!A-Za-z0-9._:-]*)
    echo "invalid proxy host" >&2
    exit 2
    ;;
esac
case "$port" in
  ''|*[!0-9]*)
    echo "invalid proxy port" >&2
    exit 2
    ;;
esac

macmini_host=${MY_SCHOLAR_MACMINI_HOST:-}
if [ -z "$macmini_host" ]; then
  echo "请设置 MY_SCHOLAR_MACMINI_HOST。" >&2
  exit 2
fi
remote_script=''
remote_script="iface=\$(route -n get '$host' 2>/dev/null | awk '/interface:/{print \$2; exit}'); ip=\$(ifconfig \"\$iface\" 2>/dev/null | awk '/inet /{print \$2; exit}'); if [ -z \"\$ip\" ]; then echo no IPv4 source for $host >&2; exit 1; fi; exec nc -4 -s \"\$ip\" -G 15 '$host' '$port'"
exec ssh -o BatchMode=yes -o ConnectTimeout=20 "$macmini_host" "$remote_script"
