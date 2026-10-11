// Laptop health API + heat guard for the Dell G3 server (no dependencies).
// Listens on 127.0.0.1:8095 only. The phone reaches it through the job agent's ssh link (phone-link,
// -R 8095), and the hub's /laptop page (owner login) shows it and sends the commands below.
//   GET  /health   temperatures, CPU, memory, disk, battery, WiFi, services, guard state
//   POST /command  {"cmd": one of COMMANDS}
// Guard: CPU package >= DANGER_C for 2 checks in a row stops the agents gently: pause them (no new application
// starts), wait until the browser finishes what it is submitting (at most 3 min; 30 s at CRITICAL_C), then stop
// the browser and the agents, and tell the owner in Cupboard. They start again by themselves after 10 minutes
// below COOL_C (at most 3 times a day), or with the Start button; only agents that were running are resumed.
import { createServer } from 'node:http';
import { readFileSync, readdirSync, existsSync, statfsSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { cpus, totalmem, freemem, uptime, loadavg, hostname, homedir } from 'node:os';
import { join } from 'node:path';

const PORT = 8095;
const WARN_C = 88, DANGER_C = 95, CRITICAL_C = 99, COOL_C = 70;   // Intel i5/i7-8xxxH: throttles near 100 °C
const J = join(homedir(), 'jobagent');
const read = (f) => { try { return readFileSync(f, 'utf8').trim(); } catch { return null; } };
const num = (f) => { const v = Number(read(f)); return Number.isFinite(v) ? v : null; };
const run = (cmd, args) => new Promise((ok) => execFile(cmd, args, { timeout: 30000 }, (e, out) => ok({ ok: !e, out: String(out || '').trim(), error: e?.message })));

function temps() {
  const out = { cores: [] };
  for (const h of readdirSync('/sys/class/hwmon')) {
    const d = join('/sys/class/hwmon', h), name = read(join(d, 'name'));
    if (name === 'coretemp') {
      for (const f of readdirSync(d).filter((x) => /^temp\d+_input$/.test(x))) {
        const label = read(join(d, f.replace('input', 'label'))) || '', c = num(join(d, f)) / 1000;
        if (/Package/.test(label)) out.cpu = c; else out.cores.push(c);
      }
    } else if (name === 'pch_cannonlake') out.chipset = num(join(d, 'temp1_input')) / 1000;
    else if (/^iwlwifi/.test(name)) out.wifi = num(join(d, 'temp1_input')) / 1000;
  }
  for (const z of readdirSync('/sys/class/thermal').filter((x) => x.startsWith('thermal_zone'))) {
    if (read(join('/sys/class/thermal', z, 'type')) === 'TSKN') out.surface = num(join('/sys/class/thermal', z, 'temp')) / 1000;
  }
  return out;
}

let lastCpu = null;
function cpuUse() {                                   // % busy since the previous call
  const t = cpus().map((c) => c.times).reduce((a, x) => ({ idle: a.idle + x.idle, all: a.all + x.user + x.nice + x.sys + x.idle + x.irq }), { idle: 0, all: 0 });
  const prev = lastCpu; lastCpu = t;
  return prev ? Math.round(100 * (1 - (t.idle - prev.idle) / Math.max(1, t.all - prev.all))) : null;
}

function battery() {
  const b = '/sys/class/power_supply/BAT0';
  if (!existsSync(b)) return null;
  const full = num(`${b}/charge_full`), design = num(`${b}/charge_full_design`);
  return { percent: num(`${b}/capacity`), status: read(`${b}/status`), cycles: num(`${b}/cycle_count`),
    health: full && design ? Math.round((100 * full) / design) : null, plugged: read('/sys/class/power_supply/AC/online') === '1' };
}

function disk(path) {
  try { const s = statfsSync(path); const size = s.blocks * s.bsize, free = s.bavail * s.bsize; return { size, used: size - free, percent: Math.round((100 * (size - free)) / size) }; } catch { return null; }
}

const SERVICES = () => ['phone-link', 'jobworker', 'jobagent', 'jobsync.timer', 'laptop-api',
  ...(existsSync(join(J, 'people')) ? readdirSync(join(J, 'people')).filter((n) => existsSync(join(J, 'people', n, 'port'))).map((n) => `jobagent@${n}`) : [])];
const AGENTS = () => SERVICES().filter((s) => s === 'jobagent' || s.startsWith('jobagent@'));

async function services() {
  const names = SERVICES(), r = await run('systemctl', ['is-active', ...names]);
  const states = r.out.split('\n');
  return Object.fromEntries(names.map((n, i) => [n, states[i] || 'unknown']));
}

async function wifi() {
  const r = await run('iw', ['dev', 'wlp2s0', 'link']);
  const ip = await run('ip', ['-4', '-br', 'addr', 'show', 'wlp2s0']);
  return { ssid: /SSID: (.+)/.exec(r.out)?.[1] || null, signal: Number(/signal: (-?\d+)/.exec(r.out)?.[1]) || null, ip: (/(\d+\.\d+\.\d+\.\d+)/.exec(ip.out) || [])[1] || null };
}

const lastSync = () => { try { return statSync(join(homedir(), '.cache', 'jobsync', 'agent.db')).mtimeMs; } catch { return null; } };

// ---- tell the owner (Cupboard internal API on the phone, through phone-link's -L 8086)
async function tell(text) {
  await fetch('http://127.0.0.1:8086/notify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(5000),
    body: JSON.stringify({ title: 'Laptop server', text }) }).catch(() => {});
}

// ---- the agents (their APIs: owner :8083, people/<name>/port)
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const PORTS = () => [8083, ...AGENTS().filter((s) => s.startsWith('jobagent@')).map((s) => Number(read(join(J, 'people', s.slice(9), 'port')))).filter(Boolean)];
const agentApi = (port, path, body) => fetch(`http://127.0.0.1:${port}${path}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) } : { signal: AbortSignal.timeout(5000) })
  .then((r) => (r.ok ? r.json() : null)).catch(() => null);
// Is the browser in the middle of something that must not be cut off (an application, a LinkedIn message or invite,
// a profile update, a sign-in)? Searches can be.
const busyBrowser = () => fetch('http://127.0.0.1:8084/health', { signal: AbortSignal.timeout(5000) }).then((r) => r.text())
  .then((h) => /apply|message|connect|refresh|"signin":"/.test(h)).catch(() => false);

let resumePorts = [];                                // agents that were running before a stop: resumed on start
async function stopGently(maxWaitMs) {
  const running = [];
  for (const p of PORTS()) { const s = await agentApi(p, '/internal/dash/summary'); if (s && !s.paused) running.push(p); await agentApi(p, '/internal/action', { action: 'pause' }); }
  resumePorts = [...new Set([...resumePorts, ...running])];
  const until = Date.now() + maxWaitMs;
  while (Date.now() < until && (temps().cpu ?? 0) < CRITICAL_C && await busyBrowser()) await sleep(5000);
  return run('sudo', ['systemctl', 'stop', ...AGENTS(), 'jobworker']);
}
async function startAndResume() {
  const r = await run('sudo', ['systemctl', 'start', 'jobworker', ...AGENTS()]);
  for (const p of resumePorts) {                     // the agents need a few seconds to come up
    for (let i = 0; i < 12; i++) { if (await agentApi(p, '/internal/action', { action: 'resume' })) break; await sleep(5000); }
  }
  resumePorts = [];
  return r;
}
const agentsUp = startAndResume;
const agentsDown = () => stopGently(guard.lastT >= CRITICAL_C ? 30e3 : 3 * 60e3);

// ---- commands (allow-list; the agents' user has passwordless sudo)
const COMMANDS = {
  // Answers at once; the gentle stop (up to 3 min while an application finishes) carries on in the background.
  stop_agents: async () => { guard.held = true; stopGently(3 * 60e3).catch(() => {}); return { ok: true }; },   // stays stopped until Start
  start_agents: async () => { guard.held = false; guard.state = 'ok'; startAndResume().catch(() => {}); return { ok: true }; },
  restart_agents: async () => { (async () => { await stopGently(3 * 60e3); await startAndResume(); })().catch(() => {}); return { ok: true }; },
  restart_browser: () => run('sudo', ['systemctl', 'restart', 'jobworker']),
  sync_now: () => run('sudo', ['systemctl', 'start', 'jobsync.service']),        // the hub calls this after each action
  reboot: () => { setTimeout(() => run('sudo', ['systemctl', 'reboot']), 1500); return { ok: true }; },
  shutdown: () => { setTimeout(() => run('sudo', ['systemctl', 'poweroff']), 1500); return { ok: true }; },
};

// ---- heat guard
const guard = { state: 'ok', since: Date.now(), reason: '', held: false, hot: 0, warm: 0, coolSince: null, restartsToday: 0, day: '', warnedAt: 0 };
async function checkHeat() {
  const t = temps().cpu;
  if (t == null || guard.busy) return;
  guard.lastT = t;
  const day = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  if (guard.day !== day) { guard.day = day; guard.restartsToday = 0; }
  if (guard.state === 'ok') {
    guard.hot = t >= DANGER_C ? guard.hot + 1 : 0;
    guard.warm = t >= WARN_C ? guard.warm + 1 : 0;      // short spikes (a browser starting) are normal: warn after a minute
    if (guard.hot >= 2) {
      Object.assign(guard, { state: 'stopped_hot', since: Date.now(), reason: `CPU ${t} °C`, coolSince: null, busy: true });
      await tell(`🔥 CPU reached ${t} °C. Pausing the job agents: no new applications; the one in progress may finish, then the browser stops to cool down.`);
      try { await agentsDown(); } finally { guard.busy = false; }
      await tell(`🧊 Job agents stopped to cool down. They start again after 10 minutes below ${COOL_C} °C (or press Start in the hub /laptop page).`);
    } else if (guard.warm >= 2 && Date.now() - guard.warnedAt > 3600e3) {
      guard.warnedAt = Date.now();
      await tell(`🌡️ CPU is hot: ${t} °C (it stops the agents at ${DANGER_C} °C). Is the laptop's air vent blocked?`);
    }
  } else if (guard.state === 'stopped_hot' && !guard.held) {
    if (t < COOL_C) guard.coolSince ??= Date.now(); else guard.coolSince = null;
    if (guard.coolSince && Date.now() - guard.coolSince > 10 * 60e3) {
      if (guard.restartsToday >= 3) { guard.held = true; await tell('Cooled down, but it overheated 3 times today: the agents stay stopped until you press Start in the hub.'); return; }
      guard.restartsToday++;
      Object.assign(guard, { state: 'ok', since: Date.now(), reason: '', hot: 0, coolSince: null });
      guard.busy = true;
      try { await agentsUp(); } finally { guard.busy = false; }
      await tell(`❄️ Cooled down to ${t} °C: the job agents are running again.`);
    }
  }
}
setInterval(() => checkHeat().catch(() => {}), 30e3);

async function health() {
  const [svc, net] = await Promise.all([services(), wifi()]);
  const mem = { total: totalmem(), available: freemem() };
  const meminfo = read('/proc/meminfo') || '';
  const kb = (k) => Number(new RegExp(`${k}:\\s+(\\d+)`).exec(meminfo)?.[1]) * 1024;
  if (kb('MemAvailable')) mem.available = kb('MemAvailable');
  const chromium = (await run('pgrep', ['-c', '-f', 'chrom'])).out;
  return {
    at: Date.now(), host: hostname(), uptime: Math.round(uptime()), load: loadavg().map((x) => Math.round(x * 100) / 100), cpus: cpus().length,
    cpu: cpuUse(), temps: temps(), limits: { warn: WARN_C, danger: DANGER_C, cool: COOL_C },
    memory: mem, swapUsed: (kb('SwapTotal') || 0) - (kb('SwapFree') || 0), disk: disk('/'), battery: battery(), wifi: net,
    services: svc, chromium: Number(chromium) || 0, lastSync: lastSync(),
    guard: { state: guard.held ? 'held' : guard.state, since: guard.since, reason: guard.reason, restartsToday: guard.restartsToday },
  };
}

createServer(async (req, res) => {
  const reply = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  try {
    if (req.method === 'GET' && req.url === '/health') return reply(200, await health());
    if (req.method === 'POST' && req.url === '/command') {
      let body = ''; for await (const c of req) { body += c; if (body.length > 1000) break; }
      const cmd = (() => { try { return JSON.parse(body).cmd; } catch { return null; } })();
      if (!Object.hasOwn(COMMANDS, cmd)) return reply(400, { ok: false, error: 'unknown command' });
      const r = await COMMANDS[cmd]();
      return reply(r.ok ? 200 : 500, { ok: r.ok, error: r.ok ? undefined : r.error });
    }
    reply(404, { ok: false });
  } catch (e) { reply(500, { ok: false, error: e.message }); }
}).listen(PORT, '127.0.0.1', () => { cpuUse(); console.log(`laptop api on 127.0.0.1:${PORT}`); });
