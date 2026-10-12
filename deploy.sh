#!/bin/bash
# Copy the hub site and the tinker server to the phone and restart the server.
# Asset links get a content hash (?v=...) because the CDN in front of the phone caches .js/.css.
# Usage: ./deploy.sh [ssh-host]   (default: the laptop, which serves it, and the S20, which keeps a standby copy)
set -e
HOSTS=${1:-"laptop-server s20phone"}
DIR=$(cd "$(dirname "$0")" && pwd)
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
cp -R "$DIR/hub" "$DIR/server" "$STAGE/"
V=$(cat "$DIR/hub/assets/hub.js" "$DIR/hub/assets/hub.css" | shasum | cut -c1-10)
sed -i '' "s|/assets/hub.css\"|/assets/hub.css?v=$V\"|; s|/assets/hub.js\"|/assets/hub.js?v=$V\"|" "$STAGE/hub/index.html"
for HOST in $HOSTS; do
  ssh -o ConnectTimeout=8 "$HOST" true 2>/dev/null || { echo "$HOST: unreachable, skipped"; continue; }
  ssh "$HOST" 'mkdir -p ~/tinker/hub ~/tinker/server/modules && chmod 700 ~/tinker'
  COPYFILE_DISABLE=1 tar --no-xattrs -C "$STAGE" -czf - hub server | ssh "$HOST" 'tar -xzf - -C ~/tinker'
  # Restart where it runs: the laptop's systemd unit, or the phone's start.sh (both skip it while ~/STANDBY exists).
  ssh "$HOST" 'if [ -d /data/data/com.termux ]; then [ -f ~/STANDBY ] || { kill $(cat $PREFIX/var/run/tinker.pid) 2>/dev/null; sleep 1; sh ~/start.sh; }
    else [ -f ~/STANDBY ] || sudo systemctl restart tinker; fi; sleep 2; [ -f ~/STANDBY ] && echo "standby: copy updated" || tail -1 ~/tinker/data/server.log'
  echo "$HOST: deployed hub (assets v=$V)"
done
