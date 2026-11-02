#!/bin/sh
# Installs the pendrive WiFi changer on the laptop. Usage: ./install.sh [ssh-host]
set -e
HOST=${1:-laptop-server}
cd "$(dirname "$0")"
scp -q wifi-drop.py wifi-drop@.service 90-wifi-drop.rules "$HOST:/tmp/"
ssh "$HOST" 'sudo install -m 755 /tmp/wifi-drop.py /usr/local/bin/wifi-drop &&
  sudo install -m 644 /tmp/wifi-drop@.service /etc/systemd/system/ &&
  sudo install -m 644 /tmp/90-wifi-drop.rules /etc/udev/rules.d/ &&
  rm /tmp/wifi-drop.py /tmp/wifi-drop@.service /tmp/90-wifi-drop.rules &&
  sudo systemctl daemon-reload && sudo udevadm control --reload && python3 -c "import yaml" && which iw netplan'
