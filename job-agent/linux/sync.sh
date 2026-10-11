#!/bin/sh
# Laptop -> S20 every 3 minutes (jobsync.timer): the phone keeps a ready-to-run copy of every agent's data
# and secrets, and its /jobs hub reads that copy. Databases go as consistent snapshots. Nothing on the
# phone writes them while ~/jobagent/STANDBY is there (see linux/failover.sh for the way back).
set -e
J=$HOME/jobagent
T=$HOME/.cache/jobsync
mkdir -p "$T"
SSH="ssh -o BatchMode=yes -o ControlMaster=auto -o ControlPath=$T/cm-%C -o ControlPersist=60"
rs() { rsync -a --timeout=60 -e "$SSH" "$@"; }

# $1 = local data dir, $2 = the same dir on the phone (relative to its home)
push_data() {
  node --no-warnings "$J/linux/snapshot.mjs" "$1/agent.db" "$T/agent.db"
  rs --delete --exclude agent.db --exclude agent.db-wal --exclude agent.db-shm --exclude live-watch "$1/" "s20phone:$2/"
  rs "$T/agent.db" "s20phone:$2/agent.db"
  $SSH s20phone "rm -f $2/agent.db-wal $2/agent.db-shm"
}

push_data "$J/data" jobagent/data
rs --delete "$J/profile/" s20phone:jobagent/profile/
for d in "$J"/people/*/; do
  [ -d "$d" ] || continue
  n=$(basename "$d")
  rs --delete --exclude data/ "$d" "s20phone:jobagent/people/$n/"
  [ -f "$d/data/agent.db" ] && push_data "${d}data" "jobagent/people/$n/data"
done
for s in "$HOME"/.jobagent "$HOME"/.jobagent-*; do [ -d "$s" ] && rs "$s" s20phone:; done
true
