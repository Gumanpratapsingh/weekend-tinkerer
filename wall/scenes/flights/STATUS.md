# Flight radar scene

Live planes within 150 km of home on a dark map: `/scenes/flights/`. The default is `?style=neon` (tilted map, neon planes, altitude sticks); `?style=radar` is the green sweep look.
Other options: `?demo=1` (a recorded sample over New Delhi, for screenshots), `?r=<km>`, `?pitch=<deg>`, `?labels=<n>`, `?lat=&lon=&name=`.

- **Home:** `home.json` (`{"lat":..,"lon":..,"name":".."}`) exists on the phone only and is gitignored. Without it the scene falls back to New Delhi.
- **Data:** `proxy.mjs` on 127.0.0.1:8098. It's needed because OpenSky allows only its own origin and adsb.fi sends no CORS header.
  - Planes: adsb.fi open data first (no key, 1 req/s), then OpenSky anonymous (400/day), then adsb.lol (500/day). Cached 10 s; a source that answers 429 is backed off.
  - Routes: adsbdb by callsign, cached 24 h in `routes-cache.json`. A route is shown only if the plane is plausibly on it.
- **Start on the phone (and the line for `~/start.sh`):**
  `nohup node ~/wall/scenes/flights/proxy.mjs > ~/wall/scenes/flights/proxy.log 2>&1 < /dev/null & echo $! > ~/wall/scenes/flights/proxy.pid`
- **Stop:** `kill $(cat ~/wall/scenes/flights/proxy.pid)`
- **Preview from the Mac:**
  - `ssh -f -N -L 127.0.0.1:18099:127.0.0.1:8099 -L 127.0.0.1:18098:127.0.0.1:8098 s20phone`
  - Then open http://localhost:18099/scenes/flights/ (the page uses proxy port 18098 when it's served from port 18099).
- **Coverage:** free ADS-B feeders around Chennai are sparse, so planes near the city often don't show. All three sources see the same few planes.
