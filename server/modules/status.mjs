// Phone health for the hub: battery, temperatures, memory, storage, what each service uses, and a 24-hour
// history. Battery/temperature come from the file phone-server/status.sh writes every minute; the rest is read
// from /proc and statfs. A sampler every 5 minutes keeps the history and pushes an alert when something is off.
import { readFileSync, statfsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { HOME, load, save, push, log } from '../core.mjs';

const FILE = join(HOME, 'live', 'status.json');
const live = () => { try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return null; } };

function memory() {
  const m = {};
  for (const line of readFileSync('/proc/meminfo', 'utf8').split('\n')) {
    const [k, v] = line.split(':');
    if (v) m[k.trim()] = parseInt(v, 10) / 1024;
  }
  return { totalMB: Math.round(m.MemTotal), availMB: Math.round(m.MemAvailable), swapTotalMB: Math.round(m.SwapTotal), swapUsedMB: Math.round(m.SwapTotal - m.SwapFree) };
}
function disk() {
  const s = statfsSync(HOME);
  return { totalGB: +(s.blocks * s.bsize / 1e9).toFixed(1), freeGB: +(s.bavail * s.bsize / 1e9).toFixed(1) };
}

// Which service a process belongs to (first match wins).
const GROUPS = [
  [/ms-playwright|chrome|Xvfb|proot|jobagent\/browser/i, 'Job agent browser'],
  [/jobagent\/src\/agent/, 'Job agent'],
  [/tinker\/server/, 'Tinker hub'],
  [/cupboard\/server/, 'Cupboard'],
  [/ai\/server/, 'Ask AI'],
  [/roomwatch|termux-sensor/, 'Room watcher'],
  [/cloudflared/, 'Tunnel'],
  [/nginx/, 'nginx'],
  [/sshd/, 'SSH'],
  [/com\.termux\.api|termux-api/, 'Termux:API'],
];
const ps = () => new Promise((ok) => execFile('ps', ['-A', '-o', 'pid=,rss=,args='], { timeout: 5000, maxBuffer: 4e6 },
  (_e, out) => ok((out || '').split('\n').map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter(Boolean)
    .map(([, pid, rss, args]) => ({ pid, rssMB: rss / 1024, group: GROUPS.find(([re]) => re.test(args))?.[1] })).filter((p) => p.group))));
const ticks = (pid) => { try { const f = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' '); return +f[11] + +f[12]; } catch { return null; } };

/** Memory now, and CPU measured over one second (percent of one core; the phone has 8). */
async function services() {
  const list = await ps();
  const t0 = new Map(list.map((p) => [p.pid, ticks(p.pid)]));
  await new Promise((r) => setTimeout(r, 1000));
  const g = {};
  for (const p of list) {
    const a = t0.get(p.pid), b = ticks(p.pid);
    const row = (g[p.group] ||= { name: p.group, memMB: 0, cpu: 0 });
    row.memMB += p.rssMB;
    if (a != null && b != null) row.cpu += (b - a);   // clock ticks are 1/100 s, so ticks in 1 s = percent of a core
  }
  return Object.values(g).map((r) => ({ ...r, memMB: Math.round(r.memMB), cpu: Math.round(r.cpu) })).sort((a, b) => b.memMB - a.memMB);
}

let history = load('health.json', []);   // [{t, cpuC, battC, battery, availMB, cpu}]
const alerted = {};
function alertOnce(key, title, body) {
  if (Date.now() - (alerted[key] || 0) < 3 * 3600e3) return;
  alerted[key] = Date.now();
  push(title, body, { tags: 'warning', priority: 'high' });
}
async function sample() {
  try {
    const s = live(), mem = memory(), d = disk(), svc = await services();
    history.push({ t: Date.now(), cpuC: s?.cpuTempC ?? null, battC: s?.batteryTempC ?? null, battery: s?.battery ?? null,
      availMB: mem.availMB, cpu: svc.reduce((n, x) => n + x.cpu, 0) });
    history = history.filter((x) => Date.now() - x.t < 24 * 3600e3);
    save('health.json', history);
    if (s?.batteryTempC >= 43) alertOnce('hot', `Phone is hot: battery ${s.batteryTempC} C`, 'Give it some air (open the cupboard a little). Heat wears the battery out fastest.');
    if (mem.availMB < 600) alertOnce('mem', `Phone memory low: ${mem.availMB} MB free`, `Biggest user: ${svc[0]?.name} (${svc[0]?.memMB} MB).`);
    if (d.freeGB < 5) alertOnce('disk', `Phone storage low: ${d.freeGB} GB free`, 'Clear old files or logs.');
  } catch (e) { log(`health sample: ${e.message}`); }
}

export default {
  start() { sample(); setInterval(sample, 5 * 60e3); },
  routes: {
    'GET /api/status': () => {
      const s = live();
      if (!s) return { online: true };
      return { online: true, battery: s.battery, charging: s.batteryStatus !== 'Discharging',
        tempC: s.cpuTempC ?? s.batteryTempC, battC: s.batteryTempC, upSince: s.upSince * 1000, updated: s.updated * 1000, availMB: memory().availMB };
    },
    'GET /api/health': async () => {
      const s = live();
      return { battery: s?.battery ?? null, batteryStatus: s?.batteryStatus ?? null,
        cpuC: s?.cpuTempC ?? null, battC: s?.batteryTempC ?? null, upSince: s ? s.upSince * 1000 : null, requests: s?.requests ?? null,
        updated: s ? s.updated * 1000 : null, cores: 8, mem: memory(), disk: disk(), services: await services(), history };
    },
  },
};
