// Mission Control wall: a fullscreen page for the monitor plugged into the S20 (Samsung DeX).
// Runs on the phone, 127.0.0.1:8099 only. Reads the job agents and the laptop through the
// reverse tunnels the laptop keeps open to the phone (8083 owner, 8093 second person, 8095 laptop-api).
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const PORT = 8099;
const AGENTS = [8083, 8093];
const BOOT = Date.now();                              // the page reloads itself when this changes (new deploy)

const get = (url, ms = 4000) => fetch(url, { signal: AbortSignal.timeout(ms) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);

// termux-battery-status takes ~1 s, so it is cached.
let battery = { at: 0, v: null };
const phoneBattery = () => {
  if (Date.now() - battery.at < 30e3) return battery.v;
  battery.at = Date.now();
  execFile('termux-battery-status', { timeout: 8000 }, (err, out) => { if (!err) try { battery.v = JSON.parse(out); } catch {} });
  return battery.v;
};

async function state() {
  const [laptop, ...people] = await Promise.all([get('http://127.0.0.1:8095/health'), ...AGENTS.map((p) => get(`http://127.0.0.1:${p}/internal/dash/summary`))]);
  const log = await get('http://127.0.0.1:8083/internal/dash/log');
  const b = phoneBattery();
  return {
    at: Date.now(),
    boot: BOOT,
    people: people.map((s, i) => s && { port: AGENTS[i], name: s.name, now: s.now, paused: s.paused, today: s.today, total: s.total, days: s.days, questions: (s.questions || []).length }).filter(Boolean),
    log: (log?.lines || []).slice(-14),
    laptop: laptop && { cpu: laptop.cpu, temp: laptop.temps?.cpu, load: laptop.load?.[0], mem: laptop.memory && Math.round((1 - laptop.memory.available / laptop.memory.total) * 100), uptime: laptop.uptime, services: laptop.services },
    phone: b && { battery: b.percentage, plugged: b.plugged, temp: b.temperature },
  };
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/state') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(await state()));
    }
    if (url.pathname === '/api/wifi') {                   // WiFi devices feed from the laptop (tunnelled to the phone's 8096)
      const w = await get('http://127.0.0.1:8096/wifi.json');
      res.writeHead(w ? 200 : 502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(w || { error: 'wifi feed not reachable' }));
    }
    if (url.pathname === '/api/log') {                    // small status notes from the page (e.g. wake lock)
      console.log(new Date().toISOString(), 'page:', url.searchParams.toString().slice(0, 200));
      res.writeHead(204); return res.end();
    }
    if (url.pathname === '/api/screen') {                 // live frame of the agent's browser
      const port = AGENTS.includes(Number(url.searchParams.get('port'))) ? url.searchParams.get('port') : AGENTS[0];
      const r = await fetch(`http://127.0.0.1:${port}/internal/dash/screen`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
      if (!r || r.status !== 200) { res.writeHead(204); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'X-Task': r.headers.get('x-task') || '', 'X-Url': r.headers.get('x-url') || '' });
      return res.end(Buffer.from(await r.arrayBuffer()));
    }
    // Extra scenes (one folder each, built in parallel sessions): /scenes/<name>/<file>
    const m = url.pathname.match(/^\/scenes\/([a-z0-9-]+)\/([A-Za-z0-9._-]*)$/);
    if (m && !m[2].startsWith('.')) {
      const types = { html: 'text/html; charset=utf-8', js: 'text/javascript', css: 'text/css', json: 'application/json', png: 'image/png', jpg: 'image/jpeg', svg: 'image/svg+xml', glb: 'model/gltf-binary' };
      try {
        const body = readFileSync(join(DIR, 'scenes', m[1], m[2] || 'index.html'));
        res.writeHead(200, { 'Content-Type': types[(m[2] || 'index.html').split('.').pop()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        return res.end(body);
      } catch { res.writeHead(404); return res.end(); }
    }
    if (url.pathname === '/') {
      console.log(new Date().toISOString(), 'page opened by', (req.headers['user-agent'] || '').slice(0, 160));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(readFileSync(join(DIR, 'index.html')));
    }
    res.writeHead(404); res.end();
  } catch (e) {
    res.writeHead(500); res.end(String(e.message || e));
  }
}).listen(PORT, '127.0.0.1', () => console.log(`wall on http://127.0.0.1:${PORT}`));
