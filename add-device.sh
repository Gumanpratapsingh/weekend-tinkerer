#!/bin/sh
# Prints one-time "add this device" links for Cupboard and the Tinker hub (15 minutes, single use), for when no
# trusted phone or computer is at hand. Open each on the new device, tap "Trust this device", then sign in.
# Usage: ./add-device.sh [ssh-host]   (default: laptop-server)
set -e
HOST=${1:-laptop-server}
P=$(ssh "$HOST" "curl -s -X POST -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:8086/device-link" | python3 -c 'import sys,json; print(json.load(sys.stdin)["path"])')
echo "Cupboard:   https://cupboard.gumanpratap.workers.dev$P"
T=$(ssh "$HOST" "node -e '
const fs = require(\"fs\"), c = require(\"crypto\"), f = process.env.HOME + \"/tinker/data/device-links.json\";
const l = (() => { try { return JSON.parse(fs.readFileSync(f, \"utf8\")); } catch { return {}; } })();
for (const [t, v] of Object.entries(l)) if (v.exp < Date.now()) delete l[t];
const t = c.randomBytes(16).toString(\"hex\"); l[t] = { by: \"add-device.sh\", exp: Date.now() + 15 * 60e3 };
fs.writeFileSync(f, JSON.stringify(l), { mode: 0o600 }); console.log(t);
'")
echo "Tinker hub: https://tinker.gumanpratap.workers.dev/device?t=$T"
