#!/bin/bash
# Creates the prod users' environment on the laptop, apart from the private one (run once, as root; safe to run again):
#   - Linux user "prod" with no login and its own home: it cannot read /home/gpsingh, and the private services can't be
#     reached from it (firewall rule on their local ports 8080-8099)
#   - its own Cupboard (database, media, push keys, logins) on 8185/8186, served at /cupboard-prod/ by nginx
#   - its own browser worker on 8184; one agent per person at /home/prod/jobagent/people/<name>/ (ports from 8103)
#   Usage: ssh laptop-server 'sudo bash ~/auto-deploy/repo/job-agent/linux/prod/install-prod.sh'
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }
SRC=$(cd "$(dirname "$0")" && pwd); REPO=$(cd "$SRC/../../.." && pwd); G=/home/gpsingh; P=/home/prod
id prod >/dev/null 2>&1 || useradd -m -d "$P" -s /usr/sbin/nologin prod
chmod 750 "$P"
install -d -o prod -g prod -m 700 "$P/jobagent" "$P/jobagent/data" "$P/jobagent/people" "$P/jobagent/profile" "$P/cupboard" "$P/cupboard/data" "$P/cupboard/server" "$P/.cache"

install -m 755 "$SRC/jobprod-sync" /usr/local/sbin/jobprod-sync
rsync -a --chown=prod:prod "$G/jobagent/node_modules/" "$P/jobagent/node_modules/"
rsync -a --chown=prod:prod "$G/cupboard/server/node_modules/" "$P/cupboard/server/node_modules/"
rsync -a --chown=prod:prod "$G/.cache/ms-playwright/" "$P/.cache/ms-playwright/"
/usr/local/sbin/jobprod-sync "$REPO" 2>/dev/null || true   # units may not exist yet on the first run
sudo -u prod cp "$P/jobagent/package.json" "$P/jobagent/.deps-installed"
sudo -u prod cp "$P/cupboard/server/package.json" "$P/cupboard/server/.installed.json"

# The settings template new people's config starts from (src/onboard.mjs), without the owner's personal parts.
python3 - "$REPO/job-agent/profile/config.json" "$P/jobagent/profile/config.json" <<'PY'
import json, os, sys
c = json.load(open(sys.argv[1]))
for k in ('tracks', 'naukri_headlines', 'naukri_resume', 'career_switch'): c.pop(k, None)
c['referrals'] = {**c.get('referrals', {}), 'companies': [], 'school': ''}
json.dump(c, open(sys.argv[2], 'w'), indent=2)
PY
chown prod:prod "$P/jobagent/profile/config.json"; chmod 600 "$P/jobagent/profile/config.json"

for u in cupboard-prod.service jobworker-prod.service 'jobagent-prod@.service' jobprod.target jobprod-firewall.service jobprod-watchdog.service jobprod-watchdog.timer; do
  install -m 644 "$SRC/$u" /etc/systemd/system/
done

# nginx: the same static app as the private Cupboard (public code, no data), a separate API port.
ln -sfn cupboard "$G/cupboard/www/cupboard-prod"
python3 - "$SRC" <<'PY'
import re, shutil, subprocess, sys, time
f = '/etc/nginx/nginx.conf'; s = open(f).read()
if '/cupboard-prod/' in s: sys.exit(0)
blocks = re.findall(r'^[ \t]*location[^\n{]*/cupboard/[^\n{]*\{.*?^[ \t]*\}\n', s, flags=re.S | re.M)
if len(blocks) < 2: sys.exit('nginx: could not find the /cupboard blocks')
prod = re.sub(r'(?<!gpsingh)/cupboard/', '/cupboard-prod/', ''.join(blocks)).replace('127.0.0.1:8085', '127.0.0.1:8185')   # the static root stays the shared app
shutil.copy(f, f'{f}.before-prod-{int(time.time())}')
open(f, 'w').write(s.replace(blocks[0], prod + blocks[0], 1))
PY
nginx -t
systemctl reload nginx

systemctl daemon-reload
systemctl enable --now jobprod-firewall.service
systemctl enable jobprod.target cupboard-prod.service jobworker-prod.service
systemctl enable --now jobprod-watchdog.timer
systemctl start jobprod.target
install -m 755 "$REPO/job-agent/linux/auto-deploy.sh" "$G/auto-deploy/auto-deploy.sh"; chown gpsingh:gpsingh "$G/auto-deploy/auto-deploy.sh"
sleep 4
systemctl is-active cupboard-prod jobworker-prod jobprod-firewall
echo "Prod environment ready. Next: its Cloudflare Worker (cupboard/worker/render-worker.sh prod), then save its URL in $P/cupboard/public-url."
