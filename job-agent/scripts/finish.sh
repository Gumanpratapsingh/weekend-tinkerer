#!/bin/sh
# CAPTCHA handoff on the Mac: prefilled forms open in a browser; you solve the CAPTCHA and press Submit.
# Usage: ./scripts/finish.sh [ssh-host]   (default s20phone; s20phone-tunnel if your Terminal can't reach the LAN)
set -e
HOST=${1:-s20phone}
cd "$(dirname "$0")/.."
# Playwright for the Mac (first run only).
[ -d mac/node_modules/playwright ] || (cd mac && npm install --silent && npx playwright install chromium)
# The phone's agent API, through ssh (it only listens on the phone's localhost).
pgrep -f "18083:127.0.0.1:8083" >/dev/null || ssh -f -N -o ExitOnForwardFailure=yes -L 127.0.0.1:18083:127.0.0.1:8083 "$HOST"
# The phone's Naukri session, so Naukri jobs open signed in here too (private, gitignored data/).
mkdir -p data/sessions && chmod 700 data/sessions
scp -q "$HOST:jobagent/data/sessions/naukri.json" data/sessions/naukri.json 2>/dev/null && chmod 600 data/sessions/naukri.json
# Tailored resumes for the waiting jobs.
mkdir -p data/handoff
ssh "$HOST" 'cd ~/jobagent && node -e "const {DatabaseSync}=require(\"node:sqlite\");const d=new DatabaseSync(\"data/agent.db\",{readOnly:true});for(const r of d.prepare(\"select resume_path from jobs where status=\x27captcha\x27 and resume_path is not null\").all())console.log(r.resume_path)"' |
  while read -r f; do scp -q "$HOST:$f" data/handoff/; done
PW_DIR="$PWD/mac/" AGENT_URL=http://127.0.0.1:18083 KEEP_BROWSER=1 node scripts/finish.mjs
