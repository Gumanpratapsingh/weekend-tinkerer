#!/bin/bash
# Copy the Cupboard Worker to the clipboard with the origin host filled in (from ~/.tinker-origin), ready to
# paste into the Cloudflare dashboard editor for the "cupboard" Worker.
set -e
ORIGIN=$(cat ~/.tinker-origin)
PREFIX=/cupboard; [ "$1" = prod ] && PREFIX=/cupboard-prod   # ./render-worker.sh prod: the prod environment's Worker
sed "s/__ORIGIN__/$ORIGIN/; s#__PREFIX__#$PREFIX#" "$(dirname "$0")/cupboard.js" | pbcopy
echo "Cupboard Worker copied (origin filled in). Paste it into the cupboard Worker and deploy."
