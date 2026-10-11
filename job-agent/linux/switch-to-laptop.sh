#!/bin/sh
# Moves the job agents from the S20 to the laptop (run on the Mac). The phone keeps a synced standby copy.
# Waits until the shared browser is idle so no application is cut off half-way, then copies everything
# the agents use (data, profiles, people, secrets, keys) and starts them on the laptop.
set -e
L=${LAPTOP:-laptop-server}
P=${PHONE:-s20phone}
cd "$(dirname "$0")/.."

ports() { ssh "$1" 'echo 8083; cat ~/jobagent/people/*/port 2>/dev/null'; }
summary() { ssh "$1" "curl -s -m5 127.0.0.1:$2/internal/dash/summary"; }
action() { ssh "$1" "curl -s -m5 -X POST -H 'Content-Type: application/json' -d '{\"action\":\"$3\"}' 127.0.0.1:$2/internal/action" >/dev/null; }

echo "1/6 pausing the phone's agents (remembering who was running)"
RESUME=${RESUME_PORTS:-}            # set it when you paused them yourself beforehand, e.g. RESUME_PORTS="8083 8093"
for p in $(ports "$P"); do
  s=$(summary "$P" "$p") || s=""
  [ -z "$RESUME_PORTS" ] && case "$s" in *'"paused":false'*) RESUME="$RESUME $p" ;; esac
  action "$P" "$p" pause || true
done
echo "   will resume on the laptop:${RESUME:- nobody}"

echo "2/6 waiting until no application, message or sign-in is in progress (searches may be cut off)"
idle=0; n=0
while [ $idle -lt 2 ]; do
  h=$(ssh "$P" 'curl -s -m5 127.0.0.1:8084/health' || echo '{}')
  # Searches may be cut off (they run again); applications, LinkedIn messages/invites, profile updates and sign-ins may not.
  case "$h" in
    *'"running":"'*apply*|*'"running":"'*message*|*'"running":"'*connect*|*'"running":"'*refresh*|*'"signin":"'*|'{}') idle=0 ;;
    *) idle=$((idle + 1)) ;;
  esac
  n=$((n + 1)); [ $n -gt 90 ] && { echo "   still busy after 15 min: giving up, run again later"; exit 1; }
  [ $idle -lt 2 ] && sleep 10
done

echo "3/6 stopping the phone's agents (standby from now on)"
ssh "$P" 'touch ~/jobagent/STANDBY && sh ~/jobagent/scripts/run.sh stop'

echo "4/6 copying data, profiles, people and secrets to the laptop"
ssh "$L" 'set -e; mkdir -p ~/jobagent ~/room
  rsync -a s20phone:jobagent/data/ ~/jobagent/data/
  rsync -a s20phone:jobagent/profile/ ~/jobagent/profile/
  rsync -a s20phone:jobagent/people/ ~/jobagent/people/
  rsync -a s20phone:.jobagent s20phone:.groq_key ~/
  for s in $(ssh s20phone "ls -d .jobagent-* 2>/dev/null"); do rsync -a "s20phone:$s" ~/; done
  rsync -a s20phone:room/ntfy-topic ~/room/ 2>/dev/null || true
  rm -f ~/jobagent/STANDBY'

echo "5/6 starting the agents on the laptop"
ssh "$L" 'sh ~/jobagent/linux/install.sh && sh ~/jobagent/scripts/run.sh restart && sudo systemctl start jobsync.timer'
sleep 20
for p in $RESUME; do action "$L" "$p" resume; done

echo "6/6 checking"
for p in $(ports "$L"); do
  echo "   laptop :$p  $(summary "$L" "$p" | cut -c1-120)"
  echo "   via phone :$p  $(summary "$P" "$p" | cut -c1-60)"
done
echo laptop-server > .primary-host
echo "done: the agents run on the laptop; the phone is on standby (linux/failover.sh switches back)"
