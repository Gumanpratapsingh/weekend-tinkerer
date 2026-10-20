#!/bin/bash
# Laptop auto-deploy: when new commits land on GitHub main, install them on the laptop without the Mac. Run every few minutes by
# the auto-deploy systemd timer (linux/install-auto-deploy.sh). Job-agent changes wait for an idle browser worker (at most 15 min,
# then go anyway); Cupboard changes wait for calls to end. Never touches data/, people/, profile/ (config, resumes), secrets.
# A failed syntax check stops the deploy; a service that does not come back is rolled back to the previous commit.
# The phone standby copy is not updated here (the Mac's ./deploy.sh does that).
set -u
D=$HOME/auto-deploy; REPO=$D/repo; STATE=$D/last-good; PENDING=$D/pending-since
mkdir -p "$D"; exec 9>"$D/lock"; flock -n 9 || exit 0
log() { echo "$(date -Is) $*" >> "$D/log"; }
notify() { printf '{"title":"Auto-deploy","text":%s,"silent":%s}' "$(node -e 'console.log(JSON.stringify(process.argv[1]))' "$1")" "${2:-false}" | curl -s -m 8 -X POST 127.0.0.1:8086/notify -H 'Content-Type: application/json' -d @- >/dev/null; }
[ -d "$REPO/.git" ] || git clone -q https://github.com/Gumanpratapsingh/weekend-tinkerer.git "$REPO" || exit 0
cd "$REPO"; git fetch -q origin main || exit 0
NEW=$(git rev-parse origin/main)
[ -f "$STATE" ] || { echo "$NEW" > "$STATE"; log "baseline $NEW"; exit 0; }
OLD=$(cat "$STATE"); [ "$NEW" = "$OLD" ] && { rm -f "$PENDING"; exit 0; }
CHANGED=$(git diff --name-only "$OLD" "$NEW" 2>/dev/null)
JA=$(echo "$CHANGED" | grep -c '^job-agent/'); CB=$(echo "$CHANGED" | grep -c '^cupboard/')
[ "$JA" -eq 0 ] && [ "$CB" -eq 0 ] && { echo "$NEW" > "$STATE"; exit 0; }

# Wait for a quiet moment.
[ -f "$PENDING" ] || date +%s > "$PENDING"
WAITED=$(( $(date +%s) - $(cat "$PENDING") ))
if [ "$JA" -gt 0 ] && [ "$WAITED" -lt 900 ] && ! curl -s -m 5 127.0.0.1:8084/health | grep -q '"running":null'; then exit 0; fi
if [ "$CB" -gt 0 ] && curl -s -m 5 -X POST -H 'Content-Type: application/json' -d '{}' 127.0.0.1:8086/calls-active | grep -qv '"active":0'; then exit 0; fi

install_tree() {   # $1 = commit
  git checkout -q --detach "$1" || return 1
  if [ "$JA" -gt 0 ]; then
    for f in $(find job-agent/src job-agent/browser -name '*.mjs'); do node --check "$f" 2>>"$D/log" || return 2; done
    rsync -a --exclude node_modules --exclude data --exclude people --exclude profile --exclude .git --exclude .primary-host --exclude STANDBY job-agent/ "$HOME/jobagent/" || return 3
    ( cd "$HOME/jobagent" && { cmp -s package.json .deps-installed 2>/dev/null || { npm install --omit=dev --no-audit --no-fund >/dev/null && cp package.json .deps-installed; }; } && sh scripts/run.sh restart >>"$D/log" 2>&1 ) || return 4
  fi
  if [ "$CB" -gt 0 ]; then
    node --check cupboard/server/index.mjs 2>>"$D/log" || return 2
    S=$(mktemp -d); mkdir -p "$S/www"; cp -R cupboard/web/. "$S/www/"
    V=$(cat cupboard/web/app.js cupboard/web/app.css | sha1sum | cut -c1-10)
    sed -i "s|/app.css\"|/app.css?v=$V\"|; s|/app.js\"|/app.js?v=$V\"|" "$S/www/index.html"
    rsync -a "$S/www/" "$HOME/cupboard/www/cupboard/" && rsync -a --exclude node_modules --exclude data cupboard/server/ "$HOME/cupboard/server/" || return 3
    rm -rf "$S"
    ( cd "$HOME/cupboard/server" && { cmp -s package.json .installed.json || { npm install --omit=dev --no-audit --no-fund --silent && cp package.json .installed.json; }; } && sudo -n systemctl restart cupboard ) || return 4
  fi
  sleep 15
  [ "$JA" -eq 0 ] || systemctl is-active --quiet jobagent jobagent@vertika jobworker || return 5
  [ "$CB" -eq 0 ] || systemctl is-active --quiet cupboard || return 5
  return 0
}
log "deploying $OLD -> $NEW (job-agent=$JA cupboard=$CB)"
if install_tree "$NEW"; then
  echo "$NEW" > "$STATE"; rm -f "$PENDING"; log "ok $NEW"
  notify "Deployed $(git log -1 --format=%s "$NEW" | cut -c1-120) ($(echo "$NEW" | cut -c1-7))" true
else
  RC=$?; log "FAILED rc=$RC, rolling back to $OLD"
  install_tree "$OLD"; echo "$NEW" > "$D/failed-commit"
  # not marked good: it retries only when a newer commit arrives
  echo "$NEW" > "$STATE"
  notify "Auto-deploy of $(echo "$NEW" | cut -c1-7) failed (step $RC); rolled back to $(echo "$OLD" | cut -c1-7). The fix commit will deploy on its own."
fi
