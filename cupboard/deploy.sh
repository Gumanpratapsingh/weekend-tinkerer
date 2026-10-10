#!/bin/bash
# Copy Cupboard (server + web app) to the phone, install its one dependency when package.json changes,
# and restart it. Asset URLs get a content hash because the CDN in front of the phone caches .js/.css.
# Usage: ./deploy.sh [ssh-host]   (default: s20phone)
set -e
HOST=${1:-s20phone}
DIR=$(cd "$(dirname "$0")" && pwd)
STAGE=$(mktemp -d); trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/www/cupboard" "$STAGE/server"
cp -R "$DIR/web/." "$STAGE/www/cupboard/"
cp "$DIR"/server/*.mjs "$DIR/server/package.json" "$STAGE/server/"
V=$(cat "$DIR/web/app.js" "$DIR/web/app.css" | shasum | cut -c1-10)
sed -i '' "s|/app.css\"|/app.css?v=$V\"|; s|/app.js\"|/app.js?v=$V\"|" "$STAGE/www/cupboard/index.html"
ssh "$HOST" 'mkdir -p ~/cupboard/data && chmod 700 ~/cupboard ~/cupboard/data'
COPYFILE_DISABLE=1 tar --no-xattrs -C "$STAGE" -czf - www server | ssh "$HOST" 'tar -xzf - -C ~/cupboard'
ssh "$HOST" 'cd ~/cupboard/server && { cmp -s package.json .installed.json || { npm install --omit=dev --no-audit --no-fund --silent && cp package.json .installed.json; }; }
  kill $(cat $PREFIX/var/run/cupboard.pid) 2>/dev/null; sleep 1; sh ~/start.sh; sleep 2; tail -2 ~/cupboard/server.out'
echo "Deployed Cupboard (assets v=$V)"
