#!/bin/bash
# Set (or change) the hub owner password. Typed into a hidden prompt; only a scrypt hash is stored,
# on the phone, in ~/tinker/auth.json (mode 600). Logs out every existing session.
HOST=${1:-s20phone}
ssh -t "$HOST" 'umask 077; mkdir -p ~/tinker/data
printf "New hub password (min 12 characters, hidden): "; read -rs P; echo
printf "Repeat it: "; read -rs Q; echo
[ "$P" = "$Q" ] || { echo "They do not match."; exit 1; }
[ ${#P} -ge 12 ] || { echo "Use at least 12 characters."; exit 1; }
printf "%s" "$P" | node -e "
const c=require(\"crypto\");let p=\"\";process.stdin.on(\"data\",d=>p+=d).on(\"end\",()=>{
const salt=c.randomBytes(16);const hash=c.scryptSync(p,salt,64);
require(\"fs\").writeFileSync(process.env.HOME+\"/tinker/auth.json\",JSON.stringify({salt:salt.toString(\"hex\"),hash:hash.toString(\"hex\")}),{mode:0o600});
require(\"fs\").writeFileSync(process.env.HOME+\"/tinker/data/sessions.json\",\"{}\",{mode:0o600});
console.log(\"Password saved. Restart the server to sign everyone out: sh ~/start.sh\")})"'
