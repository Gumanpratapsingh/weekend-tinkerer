#!/bin/bash
# Copy the hub site and the tinker server to the phone and restart the server.
# Asset links get a content hash (?v=...) because the CDN in front of the phone caches .js/.css.
# Usage: ./deploy.sh [ssh-host]   (default: s20phone from ~/.ssh/config)
set -e
HOST=${1:-s20phone}
DIR=$(cd "$(dirname "$0")" && pwd)
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
cp -R "$DIR/hub" "$DIR/server" "$STAGE/"
V=$(cat "$DIR/hub/assets/hub.js" "$DIR/hub/assets/hub.css" | shasum | cut -c1-10)
sed -i '' "s|/assets/hub.css\"|/assets/hub.css?v=$V\"|; s|/assets/hub.js\"|/assets/hub.js?v=$V\"|" "$STAGE/hub/index.html"
ssh "$HOST" 'mkdir -p ~/tinker/hub ~/tinker/server/modules && chmod 700 ~/tinker'
COPYFILE_DISABLE=1 tar --no-xattrs -C "$STAGE" -czf - hub server | ssh "$HOST" 'tar -xzf - -C ~/tinker'
ssh "$HOST" 'kill $(cat $PREFIX/var/run/tinker.pid) 2>/dev/null; sleep 1; sh ~/start.sh; sleep 2; tail -1 ~/tinker/data/server.log'
echo "Deployed hub (assets v=$V)"
