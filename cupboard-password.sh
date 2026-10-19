#!/bin/bash
# Set a new Cupboard password for one person (forgotten password). The person types it into a hidden prompt; only a
# scrypt hash is stored (same format as sign-up), on the laptop, in ~/cupboard/data/cupboard.db. Devices already signed
# in stay signed in. A new computer still needs an add-device link first: ./add-device.sh
# Usage: ./cupboard-password.sh <username> [ssh-host]   e.g. ./cupboard-password.sh v_x9
USERNAME=${1:?usage: ./cupboard-password.sh <username> [ssh-host]}
HOST=${2:-laptop-server}
case "$USERNAME" in *[!a-z0-9_.-]*) echo "Bad username."; exit 1;; esac
ssh -t "$HOST" "U='$USERNAME'"'
printf "New Cupboard password for @%s (min 8 characters, hidden): " "$U"; read -rs P; echo
printf "Repeat it: "; read -rs Q; echo
[ "$P" = "$Q" ] || { echo "They do not match. Nothing changed."; exit 1; }
[ ${#P} -ge 8 ] || { echo "Use at least 8 characters. Nothing changed."; exit 1; }
printf "%s" "$P" | U="$U" node --no-warnings -e "
const c = require(\"crypto\"), { DatabaseSync } = require(\"node:sqlite\");
let p = \"\"; process.stdin.on(\"data\", (d) => p += d).on(\"end\", () => {
  const db = new DatabaseSync(process.env.HOME + \"/cupboard/data/cupboard.db\");
  const u = db.prepare(\"SELECT id, name FROM users WHERE username = ? AND active = 1 AND role != ?\").get(process.env.U, \"bot\");
  if (!u) { console.log(\"No active Cupboard user @\" + process.env.U + \". Nothing changed.\"); process.exit(1); }
  const salt = c.randomBytes(16).toString(\"hex\");
  const hash = c.scryptSync(p, Buffer.from(salt, \"hex\"), 64).toString(\"hex\");
  db.prepare(\"UPDATE users SET salt = ?, hash = ? WHERE id = ?\").run(salt, hash, u.id);
  console.log(\"Password changed for \" + u.name + \" (@\" + process.env.U + \"). Sign in with it now.\");
});"'
