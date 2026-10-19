#!/bin/bash
# Install/refresh the arcade on the Dell: gamepad bridge + Sunshine + virtual display (system units running as gpsingh).
# Ikemen GO itself lives in ~/arcade/ikemen on the Dell (downloaded once from its GitHub release, sha256-checked).
set -e
HOST=${1:-laptop-server}
DIR=$(cd "$(dirname "$0")" && pwd)
ssh "$HOST" 'mkdir -p ~/arcade/app ~/.config/sunshine' </dev/null
COPYFILE_DISABLE=1 tar --no-xattrs -C "$DIR" -czf - pad.py pad.html sunshine.conf apps.json run-ikemen.sh shot.py padtest.py systemd | ssh "$HOST" 'tar -xzf - -C ~/arcade/app'
ssh "$HOST" 'set -e; cd ~/arcade/app
  [ -s ~/arcade/secret ] || (umask 077; head -c 32 /dev/urandom | od -An -tx1 | tr -d " \n" > ~/arcade/secret)
  cp sunshine.conf apps.json ~/.config/sunshine/
  sudo -n cp systemd/*.service /etc/systemd/system/ && sudo -n systemctl daemon-reload
  sudo -n systemctl enable --now arcade-display arcade-pad arcade-sunshine >/dev/null 2>&1
  sudo -n systemctl restart arcade-pad arcade-sunshine; sleep 4
  for u in arcade-display arcade-pad arcade-sunshine; do echo "$u: $(systemctl is-active $u)"; done' </dev/null
