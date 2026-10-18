#!/bin/bash
# Copy the Mission Control wall to the S20 and restart it. hdmi-watch.sh keeps the server on 127.0.0.1:8099
# and opens the wall on the monitor when HDMI is plugged in; ~/start.sh starts the watcher at boot.
# Usage: ./deploy.sh [ssh-host] [--open]   --open also opens it on the monitor now.
set -e
HOST=${1:-s20phone}
DIR=$(cd "$(dirname "$0")" && pwd)
ssh "$HOST" 'mkdir -p ~/wall' </dev/null
COPYFILE_DISABLE=1 tar --no-xattrs -C "$DIR" -czf - server.mjs index.html hdmi-watch.sh $(cd "$DIR" && ls -d scenes 2>/dev/null) | ssh "$HOST" 'tar -xzf - -C ~/wall'
# Stop by pid file only: a pkill pattern would also match this ssh command line.
ssh "$HOST" 'kill $(cat ~/wall/watch.pid 2>/dev/null) $(cat ~/wall/wall.pid 2>/dev/null) 2>/dev/null; sleep 1
  nohup sh ~/wall/hdmi-watch.sh > /dev/null 2>&1 < /dev/null & echo $! > ~/wall/watch.pid; sleep 3; tail -1 ~/wall/wall.log' </dev/null
[ "$2" = "--open" ] && ssh "$HOST" 'termux-open-url http://127.0.0.1:8099/' </dev/null
echo "$HOST: wall deployed"
