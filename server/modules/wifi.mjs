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
import { load, save, log, cupboard } from '../core.mjs';

const EVERY = 2 * 60e3;
const ONLINE_FOR = 10 * 60e3;                 // phones doze and skip a scan now and then: online = seen in the last 10 min
const NEW_FOR = 24 * 3600e3;
const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });

let state = load('wifi.json', { devices: {}, baseline: false, scannedAt: 0 });
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
    } else state.baseline = true;                  // the very first scan learns what is already here, quietly
    save('wifi.json', state);
  } catch (e) { log(`wifi scan: ${e.message}`); }
  finally { scanning = false; }
}

const label = (d) => d.label || niceName(d.name) || (/\.1$/.test(d.ip || '') ? 'Wi-Fi router' : null) || (d.vendor ? `${d.vendor.split(/[ ,]/)[0]} device` : isPrivate(d.mac) ? 'Phone or laptop (private address)' : 'Unknown device');

function snapshot() {
  const now = Date.now();
  const devices = Object.values(state.devices).map((d) => ({
    mac: d.mac, ip: d.ip, label: label(d), named: !!d.label, name: niceName(d.name), vendor: d.vendor, private: isPrivate(d.mac),
    online: now - d.lastSeen < ONLINE_FOR, isNew: now - d.firstSeen < NEW_FOR, firstSeen: d.firstSeen, lastSeen: d.lastSeen,
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
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(snapshot()));
    }).on('error', (e) => log(`wifi feed: ${e.message}`)).listen(8096, '127.0.0.1');
  },
  routes: {
    'GET /api/wifi': async () => snapshot(),
    'POST /api/wifi/name': async ({ body }) => {
      const mac = String(body.mac || '').toLowerCase();
      const d = state.devices[mac];
      if (!d) throw fail(404, 'No such device.');
      const name = String(body.label || '').trim().slice(0, 40);
      d.label = name || null;
      save('wifi.json', state);
      return { ok: true };
    },
    'POST /api/wifi/scan': async () => { await scan(); return snapshot(); },
  },
};
