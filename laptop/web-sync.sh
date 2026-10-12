#!/bin/sh
# Laptop -> S20 every minute (websync.timer): the phone keeps a ready-to-run copy of the hub's and Cupboard's
# data, the Ask server's cache and the website. Cupboard's database goes as a consistent snapshot.
# Nothing on the phone writes these while ~/STANDBY is there (laptop/failover-web.sh is the way back).
set -e
T=$HOME/.cache/websync
mkdir -p "$T"
SSH="ssh -o BatchMode=yes -o ControlMaster=auto -o ControlPath=$T/cm-%C -o ControlPersist=60"
rs() { rsync -a --timeout=60 -e "$SSH" "$@"; }
node --no-warnings "$HOME/jobagent/linux/snapshot.mjs" "$HOME/cupboard/data/cupboard.db" "$T/cupboard.db"
rs --delete --exclude cupboard.db --exclude cupboard.db-wal --exclude cupboard.db-shm "$HOME/cupboard/data/" s20phone:cupboard/data/
rs "$T/cupboard.db" s20phone:cupboard/data/cupboard.db
$SSH s20phone 'rm -f cupboard/data/cupboard.db-wal cupboard/data/cupboard.db-shm'
rs "$HOME/tinker/data/" s20phone:tinker/data/
rs "$HOME"/tinker/auth.json "$HOME"/tinker/people-auth.json "$HOME"/tinker/invites.json "$HOME"/tinker/sms-token s20phone:tinker/ 2>/dev/null || true
rs --exclude ask.log "$HOME/ai/" s20phone:ai/
rs "$HOME/live/now.json" s20phone:live/ 2>/dev/null || true
rs --delete "$HOME/site/" s20phone:site/
