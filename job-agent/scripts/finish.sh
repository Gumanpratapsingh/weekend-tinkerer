#!/bin/sh
# CAPTCHA handoff on the Mac: prefilled forms open in a browser; you solve the CAPTCHA and press Submit.
# Usage: ./scripts/finish.sh [ssh-host]   (default: where the agents run now)
#        PERSON=vertika ./scripts/finish.sh   (someone else's agent: their CAPTCHA list, logins and resumes)
set -e
cd "$(dirname "$0")/.."
HOST=${1:-$(cat .primary-host 2>/dev/null || echo s20phone)}   # where the agents run now (linux/switch-to-laptop.sh)
# Playwright for the Mac (first run only).
[ -d mac/node_modules/playwright ] || (cd mac && npm install --silent && npx playwright install chromium)
# The phone's agent API, through ssh (it only listens on the phone's localhost).
D=data; PORT=8083
if [ -n "$PERSON" ]; then
  case "$PERSON" in *[!a-z0-9_-]*) echo "bad PERSON"; exit 1 ;; esac
  D=people/$PERSON/data; PORT=$(ssh "$HOST" "cat ~/jobagent/people/$PERSON/port")
fi
LPORT=$((10000 + PORT))
pgrep -f "$LPORT:127.0.0.1:$PORT" >/dev/null || ssh -f -N -o ExitOnForwardFailure=yes -L 127.0.0.1:$LPORT:127.0.0.1:$PORT "$HOST"
# Their saved sessions, so jobs open signed in here too (private, gitignored).
mkdir -p "$D/sessions" && chmod 700 "$D/sessions"
for s in naukri linkedin; do scp -q "$HOST:jobagent/$D/sessions/$s.json" "$D/sessions/$s.json" 2>/dev/null && chmod 600 "$D/sessions/$s.json"; done
# Tailored resumes for the waiting jobs.
mkdir -p "$D/handoff"
ssh "$HOST" "cd ~/jobagent && node -e \"const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('$D/agent.db',{readOnly:true});for(const r of d.prepare(\\\"select resume_path from jobs where status='captcha' and resume_path is not null\\\").all())console.log(r.resume_path)\"" |
  while read -r f; do scp -q "$HOST:jobagent/${f#*/jobagent/}" "$D/handoff/" 2>/dev/null || true; done   # paths may be the phone's
PW_DIR="$PWD/mac/" AGENT_URL=http://127.0.0.1:$LPORT KEEP_BROWSER=1 JA_PERSON=$PERSON node scripts/finish.mjs
