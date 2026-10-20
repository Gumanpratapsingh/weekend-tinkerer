#!/bin/sh
# One-time, from the Mac: installs the laptop auto-deploy (new commits on GitHub main go live on the laptop within minutes, Mac or no Mac).
# Usage: ./linux/install-auto-deploy.sh [ssh-host]   Remove: sudo systemctl disable --now auto-deploy.timer
set -e
HOST=${1:-laptop-server}
scp -q "$(dirname "$0")/auto-deploy.sh" "$HOST:/tmp/auto-deploy.sh"
ssh "$HOST" 'mkdir -p ~/auto-deploy && install -m 755 /tmp/auto-deploy.sh ~/auto-deploy/auto-deploy.sh && U=$(id -un) && H=$HOME
sudo tee /etc/systemd/system/auto-deploy.service >/dev/null <<S
[Unit]
Description=Install new job-agent / Cupboard commits from GitHub
[Service]
Type=oneshot
User=$U
ExecStart=/bin/bash $H/auto-deploy/auto-deploy.sh
S
sudo tee /etc/systemd/system/auto-deploy.timer >/dev/null <<S
[Unit]
Description=Check GitHub for new commits every 3 minutes
[Timer]
OnBootSec=2min
OnUnitActiveSec=3min
[Install]
WantedBy=timers.target
S
sudo systemctl daemon-reload && sudo systemctl enable --now auto-deploy.timer && systemctl list-timers auto-deploy.timer --no-pager | head -3'
