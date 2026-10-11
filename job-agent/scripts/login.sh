#!/bin/sh
# Sign in on the Mac and send the session to the phone.
# Usage: ./scripts/login.sh linkedin|naukri [ssh-host]           (the owner)
#        PERSON=vertika ./scripts/login.sh naukri [ssh-host]     (someone else's agent: people/<person>/)
# The person types their own password/OTP in the window; only the session cookies are saved.
set -e
SITE=${1:?usage: [PERSON=name] login.sh linkedin|naukri [ssh-host]}
HOST=${2:-s20phone}
cd "$(dirname "$0")/.."
D=data/sessions; [ -n "$PERSON" ] && D=people/$PERSON/data/sessions
~/NaukriAutopilot/.venv/bin/python scripts/login.py "$SITE" $PERSON
[ -s "$D/$SITE.json" ] || exit 1
chmod 600 "$D/$SITE.json"
ssh "$HOST" "mkdir -p ~/jobagent/$D && chmod 700 ~/jobagent/$D"
scp -q "$D/$SITE.json" "$D/$SITE.ua" "$HOST:jobagent/$D/"
ssh "$HOST" "chmod 600 ~/jobagent/$D/$SITE.*"
echo "Session for $SITE${PERSON:+ ($PERSON)} is on the phone."
