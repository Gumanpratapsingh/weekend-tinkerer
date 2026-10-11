#!/bin/sh
# One-time (and after adding a person): installs the laptop's systemd units for the job agents.
# Run on the laptop as the agents' user: sh ~/jobagent/linux/install.sh
# Needs: Node >= 22.13 at /usr/local/bin/node, xvfb-run, Playwright in /opt/pw, `ssh s20phone` working
# (~/.ssh/config + /usr/local/bin/find-phone). Units don't start while ~/jobagent/STANDBY exists.
set -e
J=$HOME/jobagent
U=$(id -un)
mkdir -p "$J/data"

# The phone reaches each agent on its own port through phone-link's reverse forwards.
FWD="-R 127.0.0.1:8083:127.0.0.1:8083"
for d in "$J"/people/*/; do
  [ -f "$d/port" ] || continue
  p=$(cat "$d/port"); mkdir -p "$d/data"
  FWD="$FWD -R 127.0.0.1:$p:127.0.0.1:$p"
done

for f in "$J"/linux/units/*; do
  sed -e "s|@HOME@|$HOME|g" -e "s|@USER@|$U|g" -e "s|@FORWARDS@|$FWD|g" "$f" | sudo tee "/etc/systemd/system/$(basename "$f")" >/dev/null
done
sudo systemctl daemon-reload
sudo systemctl enable phone-link jobworker jobagent jobsync.timer >/dev/null 2>&1
for d in "$J"/people/*/; do [ -f "$d/port" ] && sudo systemctl enable "jobagent@$(basename "$d")" >/dev/null 2>&1; done
echo "installed: phone-link jobworker jobagent $(for d in "$J"/people/*/; do [ -f "$d/port" ] && printf 'jobagent@%s ' "$(basename "$d")"; done)jobsync.timer"
