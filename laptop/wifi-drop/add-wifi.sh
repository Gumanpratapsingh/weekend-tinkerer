#!/bin/sh
# Run on the Mac while it can reach the laptop (e.g. both on the iPhone hotspot).
# Adds a WiFi network to the laptop, keeping the saved ones. Usage: ./add-wifi.sh [ssh-host]
set -e
HOST=${1:-laptop-hs}
printf 'New WiFi name: '; read -r NAME
# A typo here strands the laptop, so check it against the networks this Mac has joined.
if ! networksetup -listpreferredwirelessnetworks en0 2>/dev/null | sed 's/^[[:space:]]*//' | grep -Fxq "$NAME"; then
  printf 'This Mac has never joined "%s". Add it anyway? [y/N] ' "$NAME"; read -r OK
  [ "$OK" = y ] || exit 1
fi
printf 'New WiFi password (hidden): '; stty -echo; read -r PASS; stty echo; echo
printf '%s\n%s\n' "$NAME" "$PASS" | ssh "$HOST" 'sudo wifi-drop --add'
echo "Done. Turn off the hotspot and the laptop should move to $NAME within a minute."
