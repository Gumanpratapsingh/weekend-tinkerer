#!/data/data/com.termux/files/usr/bin/sh
# Keeps the wall server up and opens the wall on the monitor whenever an HDMI display appears.
# Started by ~/start.sh (phone boot + Termux open). Needs Termux "Appear on top" to open the browser from the background.
URL=http://127.0.0.1:8099/
was=0
while true; do
  kill -0 "$(cat ~/wall/wall.pid 2>/dev/null)" 2>/dev/null || { (cd ~/wall && nohup node server.mjs >> wall.log 2>&1 < /dev/null & echo $! > ~/wall/wall.pid); sleep 2; }
  if /system/bin/cmd display get-displays 2>/dev/null | grep -q "type EXTERNAL"; then
    if [ $was = 0 ]; then
      sleep 6                                  # let DeX finish starting
      echo "$(date '+%F %T') HDMI connected, opening the wall" >> ~/wall/watch.log
      termux-open-url "$URL"
      was=1
    fi
  else
    [ $was = 1 ] && echo "$(date '+%F %T') HDMI disconnected" >> ~/wall/watch.log
    was=0
  fi
  sleep 5
done
