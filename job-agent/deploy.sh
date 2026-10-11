#!/bin/sh
# Copies the agent to the machines that run it (~/jobagent), installs deps if package.json changed, restarts.
# Usage: ./deploy.sh [ssh-host]
#   no host: the laptop and the S20 both get the code, so the standby copy stays current. Only the machine
#   that runs the agents restarts them (the other has ~/jobagent/STANDBY and just says so).
#   s20phone-tunnel deploys to the phone over USB.
set -e
cd "$(dirname "$0")"
HOSTS=${1:-"laptop-server s20phone"}
for HOST in $HOSTS; do
  ssh -o ConnectTimeout=8 "$HOST" true 2>/dev/null || { echo "$HOST: unreachable, skipped"; continue; }
  COPYFILE_DISABLE=1 tar --no-xattrs --exclude node_modules --exclude data --exclude .git --exclude .primary-host -czf - . | ssh "$HOST" 'mkdir -p ~/jobagent && tar -xzf - -C ~/jobagent'
  ssh "$HOST" 'cd ~/jobagent && { cmp -s package.json .deps-installed 2>/dev/null || { npm install --omit=dev --no-audit --no-fund >/dev/null && cp package.json .deps-installed; }; } && sh scripts/run.sh restart'
  echo "$HOST: deployed"
done
