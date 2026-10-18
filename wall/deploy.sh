#!/bin/bash
# Copy the Mission Control wall to the S20 and (re)start it on 127.0.0.1:8099.
# Usage: ./deploy.sh [ssh-host] [--open]   --open also opens it on the DeX monitor.
set -e
HOST=${1:-s20phone}
DIR=$(cd "$(dirname "$0")" && pwd)
ssh "$HOST" 'mkdir -p ~/wall'
COPYFILE_DISABLE=1 tar --no-xattrs -C "$DIR" -czf - server.mjs index.html | ssh "$HOST" 'tar -xzf - -C ~/wall'
ssh "$HOST" 'kill $(cat ~/wall/wall.pid 2>/dev/null) 2>/dev/null; sleep 1
  cd ~/wall && nohup node server.mjs > wall.log 2>&1 < /dev/null & echo $! > ~/wall/wall.pid; sleep 2; tail -1 ~/wall/wall.log'
[ "$2" = "--open" ] && ssh "$HOST" 'termux-open-url http://127.0.0.1:8099/'
echo "$HOST: wall deployed"
