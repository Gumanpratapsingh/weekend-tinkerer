// Flight radar proxy: the page can't call the flight APIs directly (OpenSky allows only its own
// origin, adsb.fi sends no CORS header), so this tiny server on 127.0.0.1:8098 fetches for it.
//   GET /flights?lat=..&lon=..&r=<km>  → { at, src, planes: [...] }   cached 10 s
//   GET /route?cs=IGO2134               → { airline, from, to }         cached 24 h (also on disk)
// Sources, in order: adsb.fi open data (no key, 1 req/s), OpenSky anonymous (400 credits/day),
// adsb.lol (500/day). A source that answers 429 is skipped until its back-off ends.
// Start (Termux): nohup node ~/wall/scenes/flights/proxy.mjs > ~/wall/scenes/flights/proxy.log 2>&1 &
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.FLIGHTS_PORT || 8098);
const UA = 'weekend-tinkerer-wall/1.0 (home wall display)';
const KT = 1.852, FT = 0.3048;

const get = async (url, ms = 12000) => {
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(ms) });
  if (r.status === 429) { const e = new Error('429'); e.retry = Number(r.headers.get('x-rate-limit-retry-after-seconds') || r.headers.get('retry-after') || 0); throw e; }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
};

// readsb-style aircraft (adsb.fi, adsb.lol) → our plane shape (metres, km/h, degrees)
const fromReadsb = (a, now) => a.lat == null ? null : {
  hex: a.hex, cs: (a.flight || '').trim(), reg: a.r || '', type: a.t || '', cat: a.category || '',
  lat: a.lat, lon: a.lon, t: now - (a.seen_pos || 0) * 1000,
  ground: a.alt_baro === 'ground',
  alt: a.alt_baro === 'ground' ? 0 : Math.round((a.alt_geom ?? a.alt_baro ?? 0) * FT),
  gs: Math.round((a.gs || 0) * KT), trk: a.track ?? a.true_heading ?? a.mag_heading ?? 0,
  vr: Math.round((a.baro_rate ?? a.geom_rate ?? 0) * FT / 60 * 10) / 10,
};

const SOURCES = {
  'adsb.fi': async (lat, lon, km) => {
    const j = await get(`https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${Math.min(250, Math.ceil(km / KT))}`);
    const now = j.now ? (j.now > 1e12 ? j.now : j.now * 1000) : Date.now();
    return (j.aircraft || j.ac || []).map((a) => fromReadsb(a, now)).filter(Boolean);
  },
  opensky: async (lat, lon, km) => {
    const dLat = km / 111, dLon = km / (111 * Math.cos(lat * Math.PI / 180));
    const q = `lamin=${(lat - dLat).toFixed(3)}&lomin=${(lon - dLon).toFixed(3)}&lamax=${(lat + dLat).toFixed(3)}&lomax=${(lon + dLon).toFixed(3)}`;
    const j = await get(`https://opensky-network.org/api/states/all?${q}`);
    return (j.states || []).filter((s) => s[6] != null).map((s) => ({
      hex: s[0], cs: (s[1] || '').trim(), reg: '', type: '', cat: '',
      lat: s[6], lon: s[5], t: (s[3] || j.time) * 1000, ground: !!s[8],
      alt: s[8] ? 0 : Math.round(s[13] ?? s[7] ?? 0), gs: Math.round((s[9] || 0) * 3.6), trk: s[10] || 0, vr: s[11] || 0,
    }));
  },
  'adsb.lol': async (lat, lon, km) => {
    const j = await get(`https://api.adsb.lol/v2/point/${lat}/${lon}/${Math.min(250, Math.ceil(km / KT))}`);
    const now = j.now || Date.now();
    return (j.ac || []).map((a) => fromReadsb(a, now)).filter(Boolean);
  },
};
const backoff = {};                                   // source → epoch ms it may be tried again
const flightCache = new Map();                        // key → { at, body }

async function flights(lat, lon, km) {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)},${km}`;
  const hit = flightCache.get(key);
  if (hit && Date.now() - hit.at < 10e3) return hit.body;
  const errors = [];
  for (const [name, fn] of Object.entries(SOURCES)) {
    if ((backoff[name] || 0) > Date.now()) { errors.push(`${name}: backing off`); continue; }
    try {
      const planes = await fn(lat, lon, km);
      const body = JSON.stringify({ at: Date.now(), src: name, planes });
      flightCache.set(key, { at: Date.now(), body });
      return body;
    } catch (e) {
      if (e.message === '429') backoff[name] = Date.now() + Math.max(e.retry || 0, name === 'adsb.fi' ? 30 : 600) * 1000;
      else backoff[name] = Date.now() + 20e3;
      errors.push(`${name}: ${e.message}`);
    }
  }
  if (hit) return hit.body;                           // stale beats nothing
  throw new Error(errors.join('; '));
}

// Routes: adsbdb.com, free, no key. Unknown callsigns are cached too, so they're asked once a day.
const ROUTES = join(DIR, 'routes-cache.json');
let routes = {};
try { routes = JSON.parse(readFileSync(ROUTES, 'utf8')); } catch {}
let saveTimer = null;
const saveRoutes = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => { try { writeFileSync(ROUTES, JSON.stringify(routes)); } catch {} }, 5000); };
const place = (a) => a && { iata: a.iata_code, icao: a.icao_code, city: a.municipality, name: a.name, country: a.country_iso_name, lat: a.latitude, lon: a.longitude };
let routeBackoff = 0;

async function route(cs) {
  const hit = routes[cs];
  if (hit && Date.now() - hit.at < 864e5) return hit.v;
  if (routeBackoff > Date.now()) return hit ? hit.v : null;
  let v = null;
  try {
    const r = await fetch(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(cs)}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
    if (r.status === 429) { routeBackoff = Date.now() + 120e3; return hit ? hit.v : null; }
    const j = await r.json().catch(() => null);
    const fr = j?.response?.flightroute;
    if (fr) v = { airline: fr.airline && { name: fr.airline.name, icao: fr.airline.icao, iata: fr.airline.iata }, iata: fr.callsign_iata, from: place(fr.origin), to: place(fr.destination) };
  } catch { return hit ? hit.v : null; }       // network trouble: don't cache a miss
  routes[cs] = { at: Date.now(), v };
  saveRoutes();
  return v;
}

const send = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  res.end(body);
};

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/flights') {
      const lat = Number(url.searchParams.get('lat')), lon = Number(url.searchParams.get('lon'));
      const km = Math.min(400, Math.max(20, Number(url.searchParams.get('r')) || 170));
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 85 || Math.abs(lon) > 180) return send(res, 400, '{"error":"lat/lon"}');
      return send(res, 200, await flights(lat, lon, km));
    }
    if (url.pathname === '/route') {
      const cs = (url.searchParams.get('cs') || '').toUpperCase();
      if (!/^[A-Z0-9]{3,8}$/.test(cs)) return send(res, 400, '{"error":"cs"}');
      return send(res, 200, JSON.stringify(await route(cs)));
    }
    if (url.pathname === '/health') return send(res, 200, JSON.stringify({ ok: true, backoff, routes: Object.keys(routes).length }));
    send(res, 404, '{}');
  } catch (e) {
    send(res, 502, JSON.stringify({ error: String(e.message || e) }));
  }
}).listen(PORT, '127.0.0.1', () => console.log(`flights proxy on http://127.0.0.1:${PORT}`));
