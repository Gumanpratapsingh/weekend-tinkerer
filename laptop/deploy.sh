#!/bin/sh
# Copies the laptop health API to the laptop server and (re)starts it. Usage: ./deploy.sh [ssh-host]
set -e
HOST=${1:-laptop-server}
cd "$(dirname "$0")"
ssh "$HOST" 'mkdir -p ~/laptop'
scp -q server.mjs laptop-api.service "$HOST:laptop/"
ssh "$HOST" 'sed -e "s|@HOME@|$HOME|g" -e "s|@USER@|$(id -un)|g" ~/laptop/laptop-api.service | sudo tee /etc/systemd/system/laptop-api.service >/dev/null &&
  sudo systemctl daemon-reload && sudo systemctl enable laptop-api >/dev/null 2>&1 && sudo systemctl restart laptop-api && sleep 1 && systemctl is-active laptop-api'
