#!/bin/sh
# Writes ~/live/status.json every 60 s for the website's "served from a laptop" badge and the uptime monitor
# (same fields the phone's status.sh wrote). Only coarse, non-sensitive health: this file is public.
LIVE=$HOME/live
B=/sys/class/power_supply/BAT0
mkdir -p "$LIVE"
UP_SINCE=$(date -d "$(uptime -s)" +%s)
cpu() { for h in /sys/class/hwmon/hwmon*; do [ "$(cat $h/name)" = coretemp ] && { echo $(( $(cat $h/temp1_input) / 1000 )); return; }; done; echo null; }
while true; do
  cap=$(cat $B/capacity 2>/dev/null || echo null)
  bstat=$(cat $B/status 2>/dev/null || echo Unknown)
  [ "$(cat /sys/class/power_supply/AC/online 2>/dev/null)" = 1 ] && [ "$bstat" != Discharging ] && bstat=Charging   # plugged in (Full/Not charging read as charging)
  t=$(cpu)
  reqs=$(wc -l < "$HOME/nginx-access.log" 2>/dev/null || echo 0)
  printf '{"device":"Dell G3 laptop (no screen)","battery":%s,"batteryStatus":"%s","batteryTempC":%s,"cpuTempC":%s,"upSince":%s,"requests":%s,"updated":%s}\n' \
    "$cap" "$bstat" "$t" "$t" "$UP_SINCE" "$reqs" "$(date +%s)" > "$LIVE/status.json.tmp"
  mv "$LIVE/status.json.tmp" "$LIVE/status.json"
  sleep 60
done
