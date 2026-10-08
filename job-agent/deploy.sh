#!/bin/sh
# Copies the agent to the phone (~/jobagent), installs deps if package.json changed, restarts both processes.
# Usage: ./deploy.sh [ssh-host]   (default s20phone; use s20phone-tunnel over USB)
set -e
HOST=${1:-s20phone}
cd "$(dirname "$0")"
COPYFILE_DISABLE=1 tar --no-xattrs --exclude node_modules --exclude data --exclude .git -czf - . | ssh "$HOST" 'mkdir -p ~/jobagent && tar -xzf - -C ~/jobagent'
ssh "$HOST" 'cd ~/jobagent && { cmp -s package.json .deps-installed 2>/dev/null || { npm install --omit=dev --no-audit --no-fund >/dev/null && cp package.json .deps-installed; }; } && sh scripts/run.sh restart'
