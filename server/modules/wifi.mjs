// Wi-Fi devices: who is on the home network. The hub server runs on the laptop, which is on the same Wi-Fi. Every
// 2 minutes it sends one UDP packet to every address on the subnet (the kernel then asks "who has this address?",
// no root needed), reads the kernel's neighbour table, and asks each device its name over mDNS (Apple devices and
// many Androids answer). Devices are keyed by MAC; one never seen before raises a single Cupboard alert.
// The owner can name devices on the hub (/wifi). Read-only JSON for the wall monitor on the S20:
// 127.0.0.1:8096/wifi.json on the laptop, forwarded to the phone by phone-link.service. MACs and names stay in
// ~/tinker/data/wifi.json (runtime data, never in git).
import dgram from 'node:dgram';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load, save, log, cupboard, HOME } from '../core.mjs';

const EVERY = 2 * 60e3;
const ONLINE_FOR = 10 * 60e3;                 // phones doze and skip a scan now and then: online = seen in the last 10 min
const NEW_FOR = 24 * 3600e3;
const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });

let state = load('wifi.json', { devices: {}, baseline: false, scannedAt: 0 });
if (state.baseline && !state.baselineAt) state.baselineAt = Date.now();   // devices known before "new" existed aren't new
let me = null;                                // this laptop: { ip, mac, iface }

function myInterface() {
  for (const [iface, addrs] of Object.entries(networkInterfaces())) {
    if (!/^(wl|en|eth)/.test(iface)) continue;
    const a = addrs.find((x) => x.family === 'IPv4' && !x.internal);
    if (a) return { iface, ip: a.address, mac: a.mac };
  }
  return null;
}

const neighbours = (iface) => new Promise((resolve) => {
  execFile('ip', ['-j', 'neigh', 'show', 'dev', iface], { timeout: 5000 }, (err, out) => {
    if (err) return resolve([]);
    try { resolve(JSON.parse(out)); } catch { resolve([]); }
  });
});

// mDNS reverse lookup (legacy unicast query to the device's port 5353): "Gumans-MacBook-Air.local".
function mdnsName(ip) {
  return new Promise((resolve) => {
    const labels = [...ip.split('.').reverse(), 'in-addr', 'arpa'];
    const q = Buffer.concat([Buffer.from([0x12, 0x34, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]),
      ...labels.map((p) => Buffer.concat([Buffer.from([p.length]), Buffer.from(p)])), Buffer.from([0, 0, 12, 0, 1])]);
    const sock = dgram.createSocket('udp4');
    const done = (v) => { clearTimeout(t); try { sock.close(); } catch {} resolve(v); };
    const t = setTimeout(() => done(null), 1500);
    sock.on('error', () => done(null));
    sock.on('message', (m) => {
      try {
        if (m.readUInt16BE(6) < 1) return done(null);
        let o = 12;
        if (m.readUInt16BE(4) > 0) { while (m[o] && (m[o] & 0xc0) !== 0xc0) o += m[o] + 1; o += (m[o] & 0xc0) === 0xc0 ? 2 : 1; o += 4; }
        while (m[o] && (m[o] & 0xc0) !== 0xc0) o += m[o] + 1;      // answer name
        o += (m[o] & 0xc0) === 0xc0 ? 2 : 1;
        o += 10;                                                  // type, class, ttl, rdlength
        const parts = [];
        while (m[o] && (m[o] & 0xc0) !== 0xc0 && parts.length < 10) { parts.push(m.subarray(o + 1, o + 1 + m[o]).toString('utf8')); o += m[o] + 1; }
        done(parts.length ? parts.join('.') : null);
      } catch { done(null); }
    });
    sock.send(q, 5353, ip, () => {});
  });
}

// Maker from the MAC prefix (IEEE list, if the laptop has it). Random "private" MACs (phones) have no maker.
let ouiText = null;
function vendor(mac) {
  if (isPrivate(mac)) return null;
  try { ouiText ??= readFileSync('/usr/share/ieee-data/oui.txt', 'utf8'); } catch { ouiText = ''; }
  const p = mac.replace(/:/g, '').slice(0, 6).toUpperCase();
  return new RegExp(`^${p}\\s+\\(base 16\\)\\s+(.+)$`, 'm').exec(ouiText)?.[1].trim() || null;
}
const isPrivate = (mac) => /^.[26ae]/i.test(mac);

const niceName = (n) => (n ? n.replace(/\.local\.?$/i, '').replace(/-/g, ' ') : null);

let scanning = false;
async function scan() {
  if (scanning) return;
  scanning = true;
  try {
    me = myInterface();
    if (!me) return;
    const base = me.ip.split('.').slice(0, 3).join('.') + '.';
    const s = dgram.createSocket('udp4');
    s.on('error', () => {});
    for (let i = 1; i < 255; i++) if (base + i !== me.ip) s.send(Buffer.from([0]), 9, base + i, () => {});
    await new Promise((r) => setTimeout(r, 5000));
    s.close();
    const now = Date.now();
    const seen = (await neighbours(me.iface))
      .filter((n) => n.lladdr && n.dst?.startsWith(base) && (n.state || []).some((x) => ['REACHABLE', 'DELAY', 'PROBE'].includes(x)));
    const fresh = [];
    for (const n of seen) {
      const mac = n.lladdr.toLowerCase();
      const d = state.devices[mac] ||= { mac, firstSeen: now, label: null, name: null, vendor: vendor(mac) };
      if (d.firstSeen === now) fresh.push(d);
      d.ip = n.dst;
      d.lastSeen = now;
      if (!d.name || now - (d.nameAt || 0) > 6 * 3600e3) {     // ask names again a few times a day
        const name = await mdnsName(n.dst);
        if (name) d.name = name;
        d.nameAt = now;
      }
    }
    // Forget devices gone for 30 days (phones change their private address now and then), unless named.
    for (const d of Object.values(state.devices)) if (now - d.lastSeen > 30 * 864e5 && !d.label) delete state.devices[d.mac];
    state.scannedAt = now;
    if (state.baseline) {
      for (const d of fresh) {
        cupboard({ title: 'Wi-Fi', text: `📶 New device on your Wi-Fi: ${label(d)} (${d.ip}${d.vendor ? `, ${d.vendor}` : ''}).\nName it on the hub → Wi-Fi.` }).catch(() => {});
        log(`wifi: new device ${d.mac} ${d.ip}`);
      }
    } else { state.baseline = true; state.baselineAt = now; }   // the very first scan learns what is already here, quietly
    save('wifi.json', state);
  } catch (e) { log(`wifi scan: ${e.message}`); }
  finally { scanning = false; }
}

const label = (d) => d.label || niceName(d.name) || (/\.1$/.test(d.ip || '') ? 'Wi-Fi router' : null) || (d.vendor ? `${d.vendor.split(/[ ,]/)[0]} device` : isPrivate(d.mac) ? 'Phone or laptop (private address)' : 'Unknown device');

// ---------- live activity: which sites each device looks up (AdGuard Home on this laptop is the home DNS) ----------
// Only website names are visible (DNS), never pages, searches or content. Devices using iCloud Private Relay, Private
// DNS or a VPN skip it. AdGuard keeps 7 days of its log; the hub reads only the latest 1000 lookups.
const AGH = 'http://127.0.0.1:3000';
const APPS = [
  [/youtube|googlevideo|ytimg|youtu\.be/, 'YouTube'], [/instagram|cdninstagram/, 'Instagram'], [/whatsapp/, 'WhatsApp'],
  [/facebook|fbcdn|fbsbx/, 'Facebook'], [/netflix|nflx/, 'Netflix'], [/hotstar|jiocinema/, 'JioHotstar'],
  [/primevideo|aiv-cdn|aiv-delivery/, 'Prime Video'], [/spotify|scdn\.co/, 'Spotify'], [/snapchat|sc-cdn/, 'Snapchat'],
  [/linkedin|licdn/, 'LinkedIn'], [/telegram/, 'Telegram'], [/twitter|twimg|(^|\.)x\.com$/, 'X'], [/reddit|redd\.it/, 'Reddit'],
  [/chatgpt|openai/, 'ChatGPT'], [/claude\.ai|anthropic/, 'Claude'], [/naukri/, 'Naukri'], [/amazon\.|media-amazon/, 'Amazon'],
  [/flipkart/, 'Flipkart'], [/swiggy/, 'Swiggy'], [/zomato/, 'Zomato'], [/myntra/, 'Myntra'], [/zoom\.us/, 'Zoom'],
  [/discord/, 'Discord'], [/twitch|ttvnw/, 'Twitch'], [/steam(powered|community|static)/, 'Steam'], [/github/, 'GitHub'],
  [/gmail|mail\.google/, 'Gmail'], [/(^|\.)google\.(com|co\.in)$/, 'Google'], [/paytm|phonepe/, 'Payments app'],
];
// Phones and computers talk to these all day in the background: never shown as "what they're doing".
const BACKGROUND = /apple|icloud|mzstatic|aaplimg|gstatic|googleapis|gvt\d|doubleclick|googlesyndication|googletag|googleadservices|ubuntu\.com|snapcraft|canonical|app-measurement|crashlytics|firebase|samsung|msftconnecttest|microsoft|windowsupdate|akamai|cloudfront|ntp\.|time\.|connectivitycheck|in-addr\.arpa|\.local$|xiaomi|miui|amazon-adsystem|scorecardresearch|dns\.google/;
const SLD = /\.(co|com|org|net|gov|ac|edu)\.(in|uk|au|jp)$/;
const site = (name) => name.toLowerCase().split('.').slice(SLD.test(name) ? -3 : -2).join('.');
const appOf = (name) => APPS.find(([re]) => re.test(name))?.[1] || null;

let qcache = { at: 0, rows: [] };
async function lookups() {
  if (Date.now() - qcache.at < 4000) return qcache.rows;
  let pass;
  try { pass = readFileSync(join(HOME, '.adguard_pass'), 'utf8').trim(); } catch { return []; }
  const r = await fetch(`${AGH}/control/querylog?limit=1000`, { headers: { Authorization: `Basic ${Buffer.from(`admin:${pass}`).toString('base64')}` },
    signal: AbortSignal.timeout(5000) }).catch(() => null);
  if (!r?.ok) return qcache.rows;
  const rows = ((await r.json()).data || []).map((q) => ({ t: Date.parse(q.time), ip: q.client,
    name: String(q.question?.name || '').replace(/\.$/, ''), blocked: /^Filtered/.test(q.reason || '') }));
  qcache = { at: Date.now(), rows };
  return rows;
}

// Per device: apps in use now (last 5 minutes) and recent sites, newest first, one line per site or app.
async function activity() {
  const rows = await lookups();
  const byIp = {};
  for (const q of rows) {
    if (!q.name || BACKGROUND.test(q.name)) continue;
    const a = byIp[q.ip] ||= { apps: {}, sites: new Map(), blocked: 0, last: 0 };
    a.last = Math.max(a.last, q.t);
    if (q.blocked) { a.blocked++; continue; }
    const app = appOf(q.name);
    if (app && Date.now() - q.t < 5 * 60e3) a.apps[app] = Math.max(a.apps[app] || 0, q.t);
    const key = app || site(q.name);
    const prev = a.sites.get(key);
    if (!prev) a.sites.set(key, { site: key, app: !!app, t: q.t, n: 1 });
    else { prev.n++; prev.t = Math.max(prev.t, q.t); }
  }
  const out = {};
  for (const [ip, a] of Object.entries(byIp)) {
    out[ip] = { now: Object.entries(a.apps).sort((x, y) => y[1] - x[1]).map(([k]) => k), last: a.last, blocked: a.blocked,
      recent: [...a.sites.values()].sort((x, y) => y.t - x.t).slice(0, 15) };
  }
  return { on: rows.length > 0, byIp: out };
}

async function withActivity(forWall = false) {
  const s = snapshot();
  const act = await activity();
  for (const d of s.devices) {
    const a = act.byIp[d.self ? '127.0.0.1' : d.ip] || null;
    d.activity = a && forWall ? { now: a.now, last: a.last, recent: a.recent.slice(0, 5) } : a;
    if (forWall) delete d.mac;
  }
  s.dns = act.on;
  return s;
}

function snapshot() {
  const now = Date.now();
  const devices = Object.values(state.devices).map((d) => ({
    mac: d.mac, ip: d.ip, label: label(d), named: !!d.label, name: niceName(d.name), vendor: d.vendor, private: isPrivate(d.mac),
    online: now - d.lastSeen < ONLINE_FOR, isNew: now - d.firstSeen < NEW_FOR && d.firstSeen > (state.baselineAt || 0), firstSeen: d.firstSeen, lastSeen: d.lastSeen,
  })).sort((a, b) => b.online - a.online || b.lastSeen - a.lastSeen);
  if (me) devices.unshift({ mac: me.mac, ip: me.ip, label: 'This laptop (hub server)', named: true, name: null, vendor: 'Dell', private: false, online: true, isNew: false, self: true, firstSeen: null, lastSeen: now });
  return { scannedAt: state.scannedAt, online: devices.filter((d) => d.online).length, total: devices.length, newToday: devices.filter((d) => d.isNew).length, devices };
}

export default {
  start() {
    setTimeout(scan, 10e3);
    setInterval(scan, EVERY);
    // Read-only feed for the wall monitor (phone-link forwards this port to the S20). Laptop localhost only, and only
    // for requests addressed to it by name, so a web page in the job agents' browser can't read it via DNS rebinding.
    createServer((req, res) => {
      const okHost = /^(127\.0\.0\.1|localhost):8096$/.test(req.headers.host || '');
      if (req.method !== 'GET' || req.url !== '/wifi.json' || !okHost) { res.writeHead(404); return res.end(); }
      withActivity(true).then((s) => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(s));
      }).catch(() => { res.writeHead(500); res.end(); });
    }).on('error', (e) => log(`wifi feed: ${e.message}`)).listen(8096, '127.0.0.1');
  },
  routes: {
    'GET /api/wifi': async () => withActivity(),
    'POST /api/wifi/name': async ({ body }) => {
      const mac = String(body.mac || '').toLowerCase();
      const d = state.devices[mac];
      if (!d) throw fail(404, 'No such device.');
      const name = String(body.label || '').trim().slice(0, 40);
      d.label = name || null;
      save('wifi.json', state);
      return { ok: true };
    },
    'POST /api/wifi/scan': async () => { await scan(); return withActivity(); },
  },
};
