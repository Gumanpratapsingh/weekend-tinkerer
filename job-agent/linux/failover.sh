#!/bin/sh
# Switch back: run the job agents on the S20 again (run on the Mac), e.g. when the laptop breaks.
#   linux/failover.sh               laptop reachable: stop it cleanly, final sync, start the phone
#   linux/failover.sh --laptop-dead the phone starts from the last backup (at most ~3 minutes old)
set -e
L=${LAPTOP:-laptop-server}
P=${PHONE:-s20phone}
cd "$(dirname "$0")/.."

if [ "$1" != --laptop-dead ]; then
  echo "1/3 stopping the laptop's agents and sending a final backup"
  ssh "$L" 'set -e; touch ~/jobagent/STANDBY
    sudo systemctl stop jobsync.timer jobagent "jobagent@*" jobworker
    sh ~/jobagent/linux/sync.sh
    sudo systemctl stop phone-link'
else
  echo "1/3 skipping the laptop (dead); its phone link drops within ~45 s"
  sleep 50
fi

echo "2/3 starting the agents on the phone"
ssh "$P" 'rm -f ~/jobagent/STANDBY && sh ~/jobagent/scripts/run.sh restart'
sleep 20

echo "3/3 checking"
for p in $(ssh "$P" 'echo 8083; cat ~/jobagent/people/*/port 2>/dev/null'); do
  echo "   phone :$p  $(ssh "$P" "curl -s -m5 127.0.0.1:$p/internal/dash/summary" | cut -c1-120)"
done
echo s20phone > .primary-host
echo "done: the agents run on the phone. Back to the laptop later with linux/switch-to-laptop.sh"
