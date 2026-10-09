#!/bin/sh
# Sign in on the Mac and send the session to the phone. Usage: ./scripts/login.sh linkedin [ssh-host]
set -e
SITE=${1:?usage: login.sh linkedin|naukri [ssh-host]}
HOST=${2:-s20phone}
cd "$(dirname "$0")/.."
~/NaukriAutopilot/.venv/bin/python scripts/login.py "$SITE"
[ -s "data/sessions/$SITE.json" ] || exit 1
chmod 600 "data/sessions/$SITE.json"
ssh "$HOST" 'mkdir -p ~/jobagent/data/sessions && chmod 700 ~/jobagent/data/sessions'
scp -q "data/sessions/$SITE.json" "data/sessions/$SITE.ua" "$HOST:jobagent/data/sessions/"
ssh "$HOST" "chmod 600 ~/jobagent/data/sessions/$SITE.*"
echo "Session for $SITE is on the phone."
