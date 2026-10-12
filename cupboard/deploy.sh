#!/bin/bash
# Copy Cupboard (server + web app) to the phone, install its one dependency when package.json changes,
# and restart it. Asset URLs get a content hash because the CDN in front of the phone caches .js/.css.
# Usage: ./deploy.sh [ssh-host]   (default: the laptop, which serves it, and the S20, which keeps a standby copy)
set -e
HOSTS=${1:-"laptop-server s20phone"}
DIR=$(cd "$(dirname "$0")" && pwd)
STAGE=$(mktemp -d); trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/www/cupboard" "$STAGE/server"
cp -R "$DIR/web/." "$STAGE/www/cupboard/"
cp "$DIR"/server/*.mjs "$DIR/server/package.json" "$STAGE/server/"
V=$(cat "$DIR/web/app.js" "$DIR/web/app.css" | shasum | cut -c1-10)
sed -i '' "s|/app.css\"|/app.css?v=$V\"|; s|/app.js\"|/app.js?v=$V\"|" "$STAGE/www/cupboard/index.html"
for HOST in $HOSTS; do
  ssh -o ConnectTimeout=8 "$HOST" true 2>/dev/null || { echo "$HOST: unreachable, skipped"; continue; }
  # A restart ends any call in progress: wait (up to 10 minutes) for calls to finish instead of cutting them off.
  for i in $(seq 1 40); do
    [ -n "$WEB_ONLY" ] && { N=0; break; }
    N=$(ssh "$HOST" "curl -s -m 4 -X POST -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:8086/calls-active" 2>/dev/null | grep -o '"active":[0-9]*' | grep -o '[0-9]*$' || true)
    [ -z "$N" ] || [ "$N" = 0 ] && break
    [ "$i" = 1 ] && echo "$HOST: a call is in progress, waiting for it to end before restarting…"
    sleep 15
  done
  [ -z "$N" ] || [ "$N" = 0 ] || { echo "$HOST: a call is still in progress, NOT deploying. Run again later."; continue; }
  ssh "$HOST" 'mkdir -p ~/cupboard/data && chmod 700 ~/cupboard ~/cupboard/data'
  if [ -n "$WEB_ONLY" ]; then   # WEB_ONLY=1 ./deploy.sh: just the app files, no server restart (safe during a call)
    COPYFILE_DISABLE=1 tar --no-xattrs -C "$STAGE" -czf - www | ssh "$HOST" 'tar -xzf - -C ~/cupboard'
    echo "$HOST: web files updated, server not restarted (assets v=$V)"; continue
  fi
  COPYFILE_DISABLE=1 tar --no-xattrs -C "$STAGE" -czf - www server | ssh "$HOST" 'tar -xzf - -C ~/cupboard'
  # Restart where it runs: the laptop's systemd unit, or the phone's start.sh (both skip it while ~/STANDBY exists).
  ssh "$HOST" 'cd ~/cupboard/server && { cmp -s package.json .installed.json || { npm install --omit=dev --no-audit --no-fund --silent && cp package.json .installed.json; }; }
    if [ -d /data/data/com.termux ]; then [ -f ~/STANDBY ] || { kill $(cat $PREFIX/var/run/cupboard.pid) 2>/dev/null; sleep 1; sh ~/start.sh; }
    else [ -f ~/STANDBY ] || sudo systemctl restart cupboard; fi; sleep 2; [ -f ~/STANDBY ] && echo "standby: copy updated" || tail -2 ~/cupboard/server.out'
  echo "$HOST: deployed Cupboard (assets v=$V)"
done
