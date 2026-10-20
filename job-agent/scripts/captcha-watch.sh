#!/bin/sh
# Mac background watcher: when a job lands on the owner's CAPTCHA list, opens it prefilled (scripts/finish.sh) and shows a
# notification. You solve the CAPTCHA and press Submit; closing the tab skips it. A job is offered once every 6 hours.
# Install: ./scripts/install-captcha-watch.sh   Stop: launchctl bootout gui/$(id -u)/com.gpsingh.captcha-watch
cd "$(dirname "$0")/.."
HOST=$(cat .primary-host 2>/dev/null || echo laptop-server)
STATE="$HOME/.captcha-watch-seen"; touch "$STATE"
while true; do
  IDS=$(ssh -o ConnectTimeout=8 -o BatchMode=yes "$HOST" "curl -s -m 8 127.0.0.1:8083/internal/captcha-jobs" 2>/dev/null |
    node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{for(const j of JSON.parse(s))console.log(j.id)}catch{}})')
  NOW=$(date +%s); NEW=0
  for ID in $IDS; do
    LAST=$(grep "^$ID " "$STATE" | tail -1 | cut -d' ' -f2)
    [ -z "$LAST" ] || [ $((NOW - LAST)) -gt 21600 ] && NEW=$((NEW + 1))
  done
  if [ "$NEW" -gt 0 ]; then
    osascript -e "display notification \"$NEW application(s) are filled and need a CAPTCHA. Opening them now.\" with title \"Job agent\"" 2>/dev/null
    for ID in $IDS; do echo "$ID $NOW" >> "$STATE"; done   # offered: closing a tab skips it, it won't reopen for 6 hours
    ./scripts/finish.sh "$HOST" >> "$HOME/.captcha-watch.log" 2>&1
  fi
  sleep 60
done
