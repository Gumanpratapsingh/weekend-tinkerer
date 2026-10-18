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
    if (url.pathname === '/api/screen') {                 // live frame of the agent's browser
      const port = AGENTS.includes(Number(url.searchParams.get('port'))) ? url.searchParams.get('port') : AGENTS[0];
      const r = await fetch(`http://127.0.0.1:${port}/internal/dash/screen`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
      if (!r || r.status !== 200) { res.writeHead(204); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'X-Task': r.headers.get('x-task') || '', 'X-Url': r.headers.get('x-url') || '' });
      return res.end(Buffer.from(await r.arrayBuffer()));
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
