#!/bin/bash
# Copy the tinker Worker to the clipboard with the private origin host filled in, ready to paste
# into the Cloudflare dashboard editor. ORIGIN comes from $TINKER_ORIGIN or ~/.tinker-origin.
set -e
ORIGIN=${TINKER_ORIGIN:-$(cat ~/.tinker-origin)}
sed "s|__ORIGIN__|$ORIGIN|" "$(dirname "$0")/tinker.js" | LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 pbcopy
echo "Copied tinker.js to the clipboard (origin filled in)."
