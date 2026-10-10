#!/bin/bash
# Copy the Cupboard Worker to the clipboard with the origin host filled in (from ~/.tinker-origin), ready to
# paste into the Cloudflare dashboard editor for the "cupboard" Worker.
set -e
ORIGIN=$(cat ~/.tinker-origin)
sed "s/__ORIGIN__/$ORIGIN/" "$(dirname "$0")/cupboard.js" | pbcopy
echo "Cupboard Worker copied (origin filled in). Paste it into the cupboard Worker and deploy."
