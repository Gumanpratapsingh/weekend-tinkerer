# Your own plane receiver (optional)

The free feeds (adsb.fi, OpenSky, adsb.lol) only see a plane when some volunteer's receiver hears it. Around Chennai there
are few of those, so planes near home are often missing. A receiver at home fills that gap: with an antenna at a window, it
hears planes up to about 150–250 km away.

## What to buy (one-time, about ₹2,000–3,500)

- An RTL-SDR USB stick: RTL-SDR Blog V3/V4, or a FlightAware Pro Stick (which has a 1090 MHz amplifier built in).
- A 1090 MHz antenna with a cable long enough to reach a window. Higher and more open sky is better.

## Set it up on the Dell (Ubuntu, `ssh laptop-server`)

1. Plug in the stick and check that it's seen: `lsusb | grep -i rtl`.
2. Install the decoder and the map page with wiedehopf's install scripts (no account and no key needed):
   ```bash
   sudo bash -c "$(wget -O - https://github.com/wiedehopf/adsb-scripts/raw/master/readsb-install.sh)"
   sudo readsb-set-location <lat> <lon>      # home, so distances and the range circle are right
   sudo bash -c "$(wget -O - https://github.com/wiedehopf/tar1090/raw/master/install.sh)"
   ```
3. Check it: `curl -s http://127.0.0.1/tar1090/data/aircraft.json | head -c 300` should list aircraft.
4. Optional: share with adsb.fi (that's how the free feed exists at all) with `curl -L -o /tmp/feed.sh https://adsb.fi/feed.sh && sudo bash /tmp/feed.sh`.

## Point the radar at it

On the phone, create `~/wall/scenes/flights/receiver.json` (it is gitignored):

```json
{ "url": "http://<laptop LAN IP>/tar1090/data/aircraft.json" }
```

If the laptop's IP changes, use a fixed DHCP lease instead, or a port in the reverse tunnels the laptop already keeps open to the phone.
The proxy reads the file on every poll, so no restart is needed. The status line on the scene then says "own receiver + adsb.fi".
