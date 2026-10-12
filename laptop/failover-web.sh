#!/bin/sh
# Switch back: the S20 serves the website, hub, Ask API and Cupboard again (run on the Mac), e.g. when the laptop breaks.
#   laptop/failover-web.sh               laptop reachable: stop it, final backup, start the phone
#   laptop/failover-web.sh --laptop-dead the phone starts from the last backup (at most ~1 minute old)
# The job agents switch separately: job-agent/linux/failover.sh.
set -e
L=${LAPTOP:-laptop-server}; P=${PHONE:-s20phone}
if [ "$1" != --laptop-dead ]; then
  echo "1/3 stopping the laptop's web services and sending a final backup"
  ssh "$L" 'set -e; touch ~/STANDBY; sudo systemctl stop tunnel tinker cupboard ask websync.timer; sh ~/laptop/web-sync.sh; sh ~/jobagent/linux/install.sh >/dev/null; sudo systemctl restart phone-link'
else
  echo "1/3 skipping the laptop (dead); waiting ~50 s for its phone link to drop"; sleep 50
fi
echo "2/3 starting nginx, tunnel, Ask API, hub and Cupboard on the phone"
ssh "$P" 'rm -f ~/STANDBY && sh ~/start.sh'
sleep 8
echo "3/3 checking (public)"
for u in https://site.gumanpratap.workers.dev/ https://tinker.gumanpratap.workers.dev/ https://cupboard.gumanpratap.workers.dev/; do
  printf '   %-45s %s\n' "$u" "$(curl -s -o /dev/null -m 15 -w '%{http_code}' "$u")"
done
echo "done: the phone serves everything again. Back to the laptop: laptop/switch-web-to-laptop.sh"
