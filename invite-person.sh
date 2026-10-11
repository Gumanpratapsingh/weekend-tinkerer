#!/bin/sh
# Makes a one-time link with which a person (people/<name>/ job agent) sets their own hub password.
# The link works once, for 7 days; the hub then logs them in and shows only their job agent.
# Usage: ./invite-person.sh <name> [--full] [ssh-host]     prints the link
#   --full: they see everything the owner sees; otherwise only their own job agent.
set -e
WHO=${1:?usage: invite-person.sh <name> [--full] [ssh-host]}
FULL=0; [ "$2" = --full ] && { FULL=1; shift; }
HOST=${2:-s20phone}
ssh "$HOST" "WHO='$WHO' FULL=$FULL node -e '
const fs = require(\"fs\"), c = require(\"crypto\"), f = process.env.HOME + \"/tinker/invites.json\";
if (!/^[a-z0-9_-]{1,30}\$/.test(process.env.WHO) || !fs.existsSync(process.env.HOME + \"/jobagent/people/\" + process.env.WHO + \"/port\")) { console.error(\"no such person\"); process.exit(1); }
const inv = (() => { try { return JSON.parse(fs.readFileSync(f, \"utf8\")); } catch { return {}; } })();
for (const [t, v] of Object.entries(inv)) if (v.exp < Date.now() || v.who === process.env.WHO) delete inv[t];   // one live link per person
const t = c.randomBytes(24).toString(\"hex\");
inv[t] = { who: process.env.WHO, full: process.env.FULL === \"1\", exp: Date.now() + 7 * 86400e3 };
fs.writeFileSync(f, JSON.stringify(inv), { mode: 0o600 });
console.log(\"https://tinker.gumanpratap.workers.dev/setup?t=\" + t);
'"
