#!/bin/sh
# Installs the Mac watcher as a login item (launchd user agent). Needs the Mac to be awake and able to ssh to the laptop.
set -e
DIR=$(cd "$(dirname "$0")/.." && pwd)
PLIST="$HOME/Library/LaunchAgents/com.gpsingh.captcha-watch.plist"
cat > "$PLIST" <<P
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.gpsingh.captcha-watch</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>$DIR/scripts/captcha-watch.sh</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>$HOME/.captcha-watch.err</string>
</dict></plist>
P
launchctl bootout "gui/$(id -u)/com.gpsingh.captcha-watch" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed. The Mac now opens CAPTCHA jobs by itself. Log: ~/.captcha-watch.log"
