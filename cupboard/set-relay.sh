#!/bin/sh
# Saves a relay (TURN) key for video calls on the laptop (and the phone standby), then checks it works.
# Providers: 1 = Cloudflare Realtime TURN (needs a card on file with Cloudflare), 2 = Metered.ca free plan (500 MB a month, no card).
# Run it in the Mac's own Terminal app. The token is typed hidden and goes over SSH on stdin, never on a command line.
# Usage: ./set-relay.sh [ssh-host]      (default: laptop-server)
set -e
HOST=${1:-laptop-server}
printf 'Provider: 1 = Cloudflare, 2 = Metered [2]: '; read -r PROV; PROV=${PROV:-2}
if [ "$PROV" = 1 ]; then
  printf 'Cloudflare TURN key ID (the "Turn Token ID"): '; read -r KID
  printf 'Cloudflare TURN API token (typing is hidden): '; stty -echo; read -r TOK; stty echo; printf '\n'
  JSON=$(printf '{"keyId":"%s","apiToken":"%s"}' "$KID" "$TOK")
else
  printf 'Metered app name (the part before .metered.live): '; read -r KID
  printf 'Metered API key (typing is hidden): '; stty -echo; read -r TOK; stty echo; printf '\n'
  JSON=$(printf '{"metered":{"app":"%s","apiKey":"%s"}}' "$KID" "$TOK")
fi
[ -n "$KID" ] && [ -n "$TOK" ] || { echo "Both are needed."; exit 1; }
printf '%s' "$JSON" | ssh "$HOST" 'umask 077; cat > ~/.cupboard_turn.json'
ssh "$HOST" "node -e '
const c = JSON.parse(require(\"fs\").readFileSync(process.env.HOME + \"/.cupboard_turn.json\", \"utf8\"));
const go = c.metered
  ? fetch(\"https://\" + encodeURIComponent(c.metered.app) + \".metered.live/api/v1/turn/credentials?apiKey=\" + encodeURIComponent(c.metered.apiKey))
  : fetch(\"https://rtc.live.cloudflare.com/v1/turn/keys/\" + encodeURIComponent(c.keyId) + \"/credentials/generate-ice-servers\",
      { method: \"POST\", headers: { Authorization: \"Bearer \" + c.apiToken, \"Content-Type\": \"application/json\" }, body: JSON.stringify({ ttl: 600 }) });
go.then((r) => console.log(r.ok ? \"Relay works. Video calls can now connect across different networks.\" : \"The provider answered \" + r.status + \": check the details.\"))
  .catch((e) => console.log(\"Could not reach the provider: \" + e.message));'"
# keep a copy on the phone standby so calls still work if the laptop is ever replaced by it
printf '%s' "$JSON" | ssh -o ConnectTimeout=8 s20phone 'umask 077; cat > ~/.cupboard_turn.json' 2>/dev/null && echo "Also saved on the phone standby." || echo "(phone standby not reachable; skipped)"
