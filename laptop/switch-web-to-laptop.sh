#!/bin/sh
# Moves the website, tunnel, Ask API, hub and Cupboard from the S20 to the laptop (run on the Mac).
# About a minute of downtime: the phone's hub and Cupboard stop, their newest data is copied, the laptop starts
# them, then the laptop's tunnel connects and the phone's is stopped. The phone keeps the room watcher and a
# synced standby copy (~/STANDBY stops its start.sh from bringing these back).
set -e
L=${LAPTOP:-laptop-server}; P=${PHONE:-s20phone}
echo "1/5 stopping the hub, Cupboard and Ask API on the phone (standby from now on)"
ssh "$P" 'touch ~/STANDBY; for s in tinker cupboard ask; do kill $(cat $PREFIX/var/run/$s.pid) 2>/dev/null; done; sleep 2'
echo "2/5 copying their newest data to the laptop"
ssh "$L" 'set -e; rsync -a s20phone:cupboard/data/ ~/cupboard/data/; rsync -a s20phone:tinker/data/ ~/tinker/data/
  rsync -a s20phone:tinker/auth.json s20phone:tinker/people-auth.json s20phone:tinker/invites.json s20phone:tinker/sms-token ~/tinker/ 2>/dev/null || true
  rsync -a --exclude ask.log s20phone:ai/ ~/ai/; rsync -a s20phone:live/now.json ~/live/ 2>/dev/null || true; rsync -a --delete s20phone:site/ ~/site/
  rm -f ~/STANDBY'
echo "3/5 starting them on the laptop (Cupboard's internal API moves here: phone-link now carries it the other way)"
ssh "$L" 'set -e; sh ~/jobagent/linux/install.sh >/dev/null; sudo systemctl restart phone-link; sleep 3
  sudo systemctl enable --now nginx ask tinker cupboard websync.timer >/dev/null 2>&1; sudo systemctl restart ask; sleep 3
  systemctl is-active nginx ask tinker cupboard phone-link | tr "\n" " "; echo'
echo "4/5 handing the Cloudflare tunnel to the laptop"
ssh "$L" ': > ~/cloudflared.log; sudo systemctl enable --now tunnel >/dev/null 2>&1'
# Only stop the phone's tunnel once the laptop's is registered with Cloudflare, or the site would go dark.
ok=0; for i in $(seq 1 20); do sleep 3; ssh "$L" 'grep -q "Registered tunnel connection" ~/cloudflared.log' && { ok=1; break; }; done
if [ $ok != 1 ]; then echo "   the laptop's tunnel did not connect: the phone keeps serving the site. Check ~/cloudflared.log on the laptop."; exit 1; fi
echo "   laptop tunnel connected"
ssh "$P" 'pkill -x cloudflared; kill $(cat $PREFIX/var/run/nginx.pid) 2>/dev/null; true'
echo "5/5 checking (public)"
sleep 5
for u in https://site.gumanpratap.workers.dev/ https://site.gumanpratap.workers.dev/live/status.json https://tinker.gumanpratap.workers.dev/ https://cupboard.gumanpratap.workers.dev/; do
  printf '   %-55s %s\n' "$u" "$(curl -s -o /dev/null -m 15 -w '%{http_code}' "$u")"
done
echo "done: the laptop serves everything; the phone is on standby (laptop/failover-web.sh switches back)"
