#!/bin/sh
# Saves one secret to the phone (~/.jobagent/<name>, mode 600) from a hidden prompt. Nothing is echoed or logged.
# Usage: ./scripts/set-secret.sh <name>        e.g. wa_token, wa_app_secret, gmail_app_password
#        ./scripts/set-secret.sh wa_verify_token --generate   (makes a random token, copies it to the clipboard)
# Uses the ssh alias s20phone-tunnel (localhost:18022), because macOS blocks Terminal from the LAN.
set -e
NAME=$1
HOST=${HOST:-s20phone-tunnel}
case "$NAME" in ''|*/*|.*) echo "usage: $0 <name> [--generate]"; exit 1 ;; esac
if [ "$2" = "--generate" ]; then
  VALUE=$(openssl rand -hex 24)
  printf %s "$VALUE" | pbcopy
  echo "Generated $NAME and copied it to the clipboard. Paste it into Meta's 'Verify token' field."
else
  printf "Paste %s (hidden), then Enter: " "$NAME"
  stty -echo; read -r VALUE; stty echo; echo
fi
[ -n "$VALUE" ] || { echo "Empty, nothing saved."; exit 1; }
printf %s "$VALUE" | ssh "$HOST" "umask 077; mkdir -p ~/.jobagent && cat > ~/.jobagent/$NAME"
echo "Saved $NAME on the phone."
