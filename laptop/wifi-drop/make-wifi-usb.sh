#!/bin/sh
# Run on the Mac with the pendrive plugged in. Asks for the new WiFi and writes it to the drive.
# Usage: ./make-wifi-usb.sh /Volumes/WIFIDROP
set -e
VOL=${1:-/Volumes/WIFIDROP}
[ -d "$VOL" ] || { echo "No drive at $VOL"; exit 1; }
if [ -f "$VOL/wifi-result.txt" ]; then echo "Last result from the laptop:"; cat "$VOL/wifi-result.txt"; echo; fi
printf 'WiFi name: '; read -r NAME
printf 'WiFi password (hidden): '; stty -echo; read -r PASS; stty echo; echo
rm -f "$VOL/wifi-result.txt"
printf '%s\n%s\n' "$NAME" "$PASS" > "$VOL/wifi.txt"
diskutil eject "$VOL" >/dev/null
echo "Done. Plug the drive into the laptop, wait 2 minutes, then plug it back into the Mac."
echo "The outcome and the laptop's new IP are in wifi-result.txt on the drive."
