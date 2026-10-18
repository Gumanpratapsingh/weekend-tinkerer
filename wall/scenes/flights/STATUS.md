# Flight radar: status

Stopped early (usage limit). Done: `proxy.mjs`, tested on the Mac. It serves 127.0.0.1:8098 `/flights?lat&lon&r` (adsb.fi → OpenSky → adsb.lol, 10 s cache, backs off on 429) and `/route?cs=` (adsbdb, 24 h cache). OpenSky blocks browser CORS and allows anonymous users only 400 calls a day, hence the proxy.
Next: build `index.html` (MapLibre 4.7.1 + OpenFreeMap; `?style=radar|neon`; `?demo=1` with a recorded `demo.json` around Delhi), put a gitignored `home.json` on the phone only, start the proxy there with nohup + `proxy.pid`, take screenshots, commit.
