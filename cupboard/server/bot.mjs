// The "S20" bot: answers the owner's commands and relays answers/buttons back to the service that asked.
// It only reads the phone's own files and talks to localhost or the owner's private ntfy topics.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOME } from './db.mjs';

const read = (p) => { try { return JSON.parse(readFileSync(join(HOME, p), 'utf8')); } catch { return null; } };
const rupees = (n) => '₹' + Math.round(n).toLocaleString('en-IN');
const istDate = (t = Date.now()) => new Date(t + 5.5 * 3600e3).toISOString().slice(0, 10);
const ago = (t) => { const h = (Date.now() - t) / 3600e3; return h < 48 ? `${Math.max(1, Math.round(h))} h` : `${Math.round(h / 24)} days`; };

async function ntfy(suffix, message) {
  const topic = readFileSync(join(HOME, 'room', 'ntfy-topic'), 'utf8').trim();
  const r = await fetch(`https://ntfy.sh/${topic}${suffix}`, { method: 'POST', body: message, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`ntfy ${r.status}`);
}
async function forward(url, payload) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json().catch(() => ({}));
}

function spent(days) {
  const d = read('tinker/data/expenses.json');
  if (!d) return null;
  const since = istDate(Date.now() - (days - 1) * 86400e3);
  const items = d.items.filter((i) => (days === 'month' ? i.date.startsWith(istDate().slice(0, 7)) : i.date >= since));
  const by = {};
  for (const i of items) by[i.category] = (by[i.category] || 0) + i.amount;
  const total = items.reduce((s, i) => s + i.amount, 0);
  return `${rupees(total)} across ${items.length} entr${items.length === 1 ? 'y' : 'ies'}` +
    (total ? '\n' + Object.entries(by).sort((a, b) => b[1] - a[1]).map(([c, v]) => `${c} ${rupees(v)}`).join(' · ') : '');
}
function status() {
  const s = read('live/status.json'), room = read('room/state.json');
  const lines = [];
  if (s) lines.push(`🟢 Online ${ago(s.upSince * 1000)} · 🔋${s.battery}% · ${Math.round(s.cpuTempC)}°C · ${s.requests} requests today`);
  if (room) lines.push(`Room: lights ${room.lights || '?'} (${Math.round(room.lux ?? 0)} lux) · alerts ${room.armed ? 'ARMED' : 'off'}`);
  const today = spent(1);
  if (today) lines.push(`Spent today: ${today.split('\n')[0]}`);
  return lines.join('\n') || 'Online.';
}
const HELP = `Things I understand:
• status — phone health, room, today's spending
• room · arm · disarm
• spent today · spent week · spent month
• an expense like "250 swiggy dinner"
• to answer a question I sent, tap Reply on it (or its buttons)`;

/** The owner wrote to the bot. replyTo is the bot message being answered (or null). */
export async function botReply({ text, replyTo, say, update }) {
  const t = text.trim(), low = t.toLowerCase();
  const card = replyTo?.extra ? JSON.parse(replyTo.extra) : null;
  if (card?.replyTo) {
    try {
      await forward(card.replyTo, { text: t, ref: card.ref });
      update(replyTo.id, { done: `Answered: ${t.slice(0, 40)}` });
      return say('Sent ✓');
    } catch (e) { return say(`Couldn't deliver that answer (${e.message}). Is the service running?`); }
  }
  if (/^(help|hi|hello|hey|\?)$/.test(low)) return say(HELP);
  if (low === 'status') return say(status());
  if (low === 'room') { const r = read('room/state.json'); return say(r ? `Lights ${r.lights} (${Math.round(r.lux)} lux) · alerts ${r.armed ? 'ARMED' : 'off'}` : 'No room data yet.'); }
  if (low === 'arm' || low === 'disarm') { await ntfy('-ctl', low); return say(low === 'arm' ? 'Arming room alerts… 🔒' : 'Disarming room alerts… 🔓'); }
  const sp = /^spent(?:\s+(today|week|month))?$/.exec(low);
  if (sp) { const p = sp[1] || 'today'; const v = spent(p === 'today' ? 1 : p === 'week' ? 7 : 'month'); return say(v ? `Spent ${p === 'today' ? 'today' : `this ${p}`}: ${v}` : 'No expense data yet.'); }
  if (/^₹?\s*\d+(\.\d+)?\s+\S/.test(t)) { await ntfy('-exp', t.replace(/^₹\s*/, '')); return say('Logging it… you\'ll get a confirmation in a moment.'); }
  return say(`I didn't get that. ${HELP}`);
}

/** The owner tapped a button on a bot card. */
export async function botAction({ row, action, say, update }) {
  const card = row.extra ? JSON.parse(row.extra) : {};
  if (card.done) return update(row.id, {});
  const a = (card.actions || []).find((x) => x.id === action);
  if (!a) throw Object.assign(new Error('Unknown action.'), { status: 400, expose: true });
  if (a.id === 'undo-expense') { await ntfy('-exp', 'undo'); return update(row.id, { done: '↶ Undone' }); }
  if (!card.replyTo) throw Object.assign(new Error('Nothing to send this to.'), { status: 400, expose: true });
  try { await forward(card.replyTo, { action: a.id, text: a.label, ref: card.ref }); }
  catch (e) { await say(`Couldn't deliver "${a.label}" (${e.message}).`); throw Object.assign(new Error('Delivery failed.'), { status: 502, expose: true }); }
  return update(row.id, { done: a.label });
}
