#!/bin/sh
# Things that stay on the S20 and are shown on the laptop: the room light watcher's state (every 2 s, for the
# hub's live Room page) and the phone's own health (every minute, as ~/live/phone.json for the hub).
mkdir -p "$HOME/room" "$HOME/live"
SSH="ssh -o BatchMode=yes -o ControlMaster=auto -o ControlPath=$HOME/.cache/from-phone-%C -o ControlPersist=120"
n=0
while true; do
  rsync -a --timeout=20 -e "$SSH" s20phone:room/state.json s20phone:room/events.jsonl "$HOME/room/" 2>/dev/null
  [ $((n % 30)) -eq 0 ] && rsync -a --timeout=20 -e "$SSH" s20phone:live/status.json "$HOME/live/phone.json" 2>/dev/null
  n=$((n + 1)); sleep 2
done
