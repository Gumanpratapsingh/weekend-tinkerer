// System health, checked by the owner's agent every 10 minutes: failures that are silent otherwise and leave everyone
// without applications or without a standby (2026-10-29: the S20 standby was off for 5 days and nobody knew).
// One urgent alert per problem, repeated at most every 6 hours while it lasts, and a short "OK again" when it clears.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOME, DATA, log } from './core.mjs';
import { all, getKv, setKv } from './db.mjs';
import { tell } from './whatsapp.mjs';

const read = (f) => { try { return readFileSync(f, 'utf8'); } catch { return null; } };
const ago = (s) => (s >= 7200 ? `${Math.round(s / 3600)} hours` : `${Math.round(s / 60)} minutes`);
const NAME = { power: 'laptop power', phone: 'the S20 standby', phonebattery: 'the S20 battery', worker: 'the browser worker', ai: 'the AI answer engine' };

async function problems() {
  const out = [];
  // The laptop's battery holds about 10% of its design charge (well under an hour): on battery, everything stops soon.
  if (read('/sys/class/power_supply/AC/online')?.trim() === '0')
    out.push(['power', `🔋 The laptop is on battery (${read('/sys/class/power_supply/BAT0/capacity')?.trim() || '?'}%). It lasts well under an hour: plug it in or both agents stop.`]);
  // The standby phone's status reaches ~/live/phone.json every few seconds while it is reachable (from-phone.service).
  let ph = null; try { ph = JSON.parse(read(join(HOME, 'live', 'phone.json')) || 'null'); } catch { /* half-written */ }
  const age = ph?.updated ? Date.now() / 1000 - ph.updated : Infinity;
  if (age > 30 * 60) out.push(['phone', `📵 The S20 standby hasn't reported for ${Number.isFinite(age) ? ago(age) : 'a long time'} (last battery ${ph?.battery ?? '?'}%). If the laptop fails there is no backup: check it is on, charging and on Wi-Fi (its IP may have changed).`]);
  else if (ph?.battery < 20 && /discharg/i.test(ph.batteryStatus || '')) out.push(['phonebattery', `🪫 The S20 standby is at ${ph.battery}% and not charging.`]);
  // Without the browser worker nothing is searched or applied to.
  if (!await fetch('http://127.0.0.1:8084/health', { signal: AbortSignal.timeout(5000) }).then((r) => r.ok).catch(() => false))
    out.push(['worker', '🧩 The browser worker (127.0.0.1:8084) is not answering: no applications or searches until it is back (sudo systemctl restart jobworker).']);
  // Free AI tiers: every provider rate-limited or failing, again and again in the last hour.
  const since = Date.now() - 3600e3;
  const ai = (read(join(DATA, 'errors.jsonl')) || '').split('\n').slice(-400).filter((l) => {
    try { const e = JSON.parse(l); return Date.parse(e.at) > since && /LLM providers|rate.?limit|AI busy/i.test(e.message); } catch { return false; }
  }).length;
  if (ai >= 5) out.push(['ai', `🤖 The AI answer engine failed ${ai} times in the last hour (free-tier limits): applications wait until it recovers.`]);
  return out;
}

export async function health() {
  const now = await problems();
  for (const [name, text] of now) {
    if (Date.now() - Number(getKv(`health:${name}`, 0)) < 6 * 3600e3) continue;
    setKv(`health:${name}`, Date.now());
    log(`health: ${name}`);
    tell(text, { urgent: true });
  }
  for (const r of all("SELECT key, value FROM kv WHERE key LIKE 'health:%' AND value != '0'")) {
    const name = r.key.slice('health:'.length);
    if (now.some(([n]) => n === name)) continue;
    setKv(r.key, '0');
    tell(`✅ OK again: ${NAME[name] || name}.`);
  }
}
