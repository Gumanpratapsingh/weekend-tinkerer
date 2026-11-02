#!/bin/sh
# Adds a new person to the job agents, in two steps (run on the Mac; the agents live on the laptop).
# Everyone added here lands in the PROD environment (job-agent/linux/prod/): Linux user "prod", its own Cupboard and database.
# It cannot see the private Cupboard or the owners' agents, and the private hub doesn't know these people.
#
#   ./add-person.sh <name>                         1) their agent folder, a free port, NCR watch off, an empty private
#                                                     keys folder, and a prod Cupboard invite link to send them
#   (you add their Gemini + Groq keys; they open the invite and pick a Cupboard username)
#   ./add-person.sh <name> --cupboard <username>   2) checks the keys and their Cupboard account, starts their agent
#                                                     (it greets them in Cupboard and runs the whole setup there: resume,
#                                                     roles, cities, salary, Gmail, LinkedIn, Naukri)
#
# <name>: lowercase letters/digits/-/_ (the folder people/<name>/). Safe to run again.
# They start in dry run (forms filled, nothing sent) and, once they send "go live", two weeks of review mode.
set -e
NAME=$1; HOST=${HOST:-laptop-server}
case "$NAME" in ''|*[!a-z0-9_-]*) echo "usage: $0 <name> [--cupboard <username>]   (name: lowercase letters, digits, - or _)"; exit 1 ;; esac
[ "$2" = --cupboard ] && { CB=$3; case "$CB" in ''|*[!a-zA-Z0-9_.-]*) echo "usage: $0 $NAME --cupboard <their Cupboard username>"; exit 1 ;; esac; }
AS_PROD="sudo -n -u prod env HOME=/home/prod"

if [ -z "$CB" ]; then
  # ---------- step 1 ----------
  ssh "$HOST" "$AS_PROD N='$NAME' sh -s" <<'EOF_STEP1'
set -e
cd "$HOME"
[ -s "$HOME/cupboard/public-url" ] || { echo "No $HOME/cupboard/public-url yet: finish the prod Cupboard Worker first (job-agent/linux/prod/install-prod.sh says how)."; exit 1; }
J=$HOME/jobagent; P=$J/people/$N
mkdir -p "$P/data" "$P/profile"
# A free port: not another person's, not listening (8103, 8113, ...).
if [ ! -f "$P/port" ]; then
  port=8103
  while cat "$J"/people/*/port 2>/dev/null | grep -qx "$port" || ss -ltn | grep -q ":$port\b"; do port=$((port + 10)); done
  echo "$port" > "$P/port"
fi
# NCR (Gurgaon/Noida) watch off for new people: on, it holds their NCR jobs back as "apply yourself" cards.
[ -f "$P/profile/config.json" ] || echo '{ "ncr": { "enabled": false } }' > "$P/profile/config.json"
umask 077; mkdir -p "$HOME/.jobagent-$N"
echo "agent folder: ~prod/jobagent/people/$N (port $(cat "$P/port"))"
cd ~/cupboard/server && node --no-warnings -e '
import("./db.mjs").then(({ run, owner }) => {
  const fs = require("fs"), t = require("crypto").randomBytes(16).toString("hex"), url = fs.readFileSync(process.env.HOME + "/cupboard/public-url", "utf8").trim();
  // What their agent will do, shown on the invite page before they join (built from their real settings).
  const plan = require("child_process").execFileSync("node", ["--no-warnings", process.env.HOME + "/jobagent/linux/prod/invite-plan.mjs", process.env.N], { encoding: "utf8" });
  run("INSERT INTO invites(token, created_by, expires, plan) VALUES(?,?,?,?)", t, owner()?.id ?? null, Date.now() + 7 * 86400e3, plan);
  console.log("\nProd Cupboard invite (works once, 7 days), send it to them:\n" + url + "/invite/" + t);
})'
EOF_STEP1
  cat <<EOF2

Now add their two free AI keys (they create them, you paste each at the hidden prompt; nothing is echoed or logged):
  ssh -t $HOST "$AS_PROD sh -c 'umask 077; printf \"Gemini key: \"; stty -echo; read k; stty echo; echo; printf %s \"\\\$k\" > ~/.jobagent-$NAME/gemini_key'"
  ssh -t $HOST "$AS_PROD sh -c 'umask 077; printf \"Groq key: \"; stty -echo; read k; stty echo; echo; printf %s \"\\\$k\" > ~/.jobagent-$NAME/groq_key'"

When they've opened the invite and told you their Cupboard username:
  $0 $NAME --cupboard <their username>
EOF2
  exit 0
fi

# ---------- step 2 ----------
ssh "$HOST" "$AS_PROD N='$NAME' CB='$CB' sh -s" <<'EOF_STEP2'
set -e
cd "$HOME"
J=$HOME/jobagent; P=$J/people/$N; K=$HOME/.jobagent-$N
[ -f "$P/port" ] || { echo "No agent folder for $N yet: run ./add-person.sh $N first."; exit 1; }
for k in gemini_key groq_key; do [ -s "$K/$k" ] || { echo "Missing $K/$k: add their $k first (see step 1)."; exit 1; }; done
chmod 700 "$K"; chmod 600 "$K"/*
# Their Cupboard account must exist: the agent's first message (the setup) goes to it.
cd ~/cupboard/server
node --no-warnings -e '
import("./db.mjs").then(({ one }) => {
  const u = one("SELECT id FROM users WHERE username = ? AND active = 1 AND role != ?", process.env.CB.toLowerCase(), "bot");
  if (!u) { console.error(`No Cupboard user "${process.env.CB}" yet: they need to open the invite link and pick a username first.`); process.exit(1); }
})'
# private.json: who they are in Cupboard (the setup fills in the rest from their resume and answers).
node -e '
const f = require("fs"), p = process.env.HOME + "/jobagent/people/" + process.env.N + "/profile/private.json";
const j = (() => { try { return JSON.parse(f.readFileSync(p, "utf8")); } catch { return {}; } })();
j.cupboard_user = process.env.CB.toLowerCase(); j.known_answers ??= {};
f.writeFileSync(p, JSON.stringify(j, null, 2), { mode: 0o600 });'
EOF_STEP2
ssh "$HOST" "sudo -n systemctl enable --now 'jobagent-prod@$NAME' >/dev/null; sleep 6
systemctl is-active 'jobagent-prod@$NAME' >/dev/null && echo 'jobagent-prod@$NAME is running: it is greeting $CB in Cupboard now.' \
  || { echo 'jobagent-prod@$NAME did not come up:'; journalctl -u 'jobagent-prod@$NAME' -n 15 --no-pager; exit 1; }"
cat <<EOF2

Next, all in their own Cupboard chat: resume -> check details -> roles, cities, salary -> Gmail app password ->
LinkedIn and Naukri sign-in -> setup questions. They start in dry run; "go live" starts two weeks of review mode.
If they are moving to Gurgaon/Noida, they can send "ncr on" (or "ncr auto on") in their chat.
EOF2
