#!/bin/bash
# Copy the hub site and the tinker server to the phone and restart the server.
# Usage: ./deploy.sh [ssh-host]   (default: s20phone from ~/.ssh/config)
set -e
HOST=${1:-s20phone}
DIR=$(cd "$(dirname "$0")" && pwd)
ssh "$HOST" 'mkdir -p ~/tinker/hub ~/tinker/server/modules && chmod 700 ~/tinker'
COPYFILE_DISABLE=1 tar --no-xattrs -C "$DIR" -czf - hub server | ssh "$HOST" 'tar -xzf - -C ~/tinker'
ssh "$HOST" 'kill $(cat $PREFIX/var/run/tinker.pid) 2>/dev/null; sleep 1; sh ~/start.sh; sleep 2; tail -1 ~/tinker/data/server.log'
