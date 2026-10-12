// "Our corner 🌙" (the name is changeable with "love name: …"): a chat that belongs to Vertika alone (Guman is not a member).
// What she does there (reads a note, taps a button, reacts, writes) arrives in a separate chat of his own, "Her activity 👀",
// with a notification.
// Once a week (a random day each week, "love per week: N" changes how many), at a random moment between 10:30 PM and
// 5:00 AM India time, the AI writes a NEW short note (praise, gratitude, "I'm lucky to have you") in Guman's voice and it
// pops up on her phone only. There is no stock list.
// Guman's own notes, saved from his private S20 chat with "love: <note>", go out first and word for word.
// Other commands there: love now · love pause · love resume · love status · love style: <how it should sound> · love name: <chat name>.
// Uses the Cupboard-only AI keys (~/.cupboard_gemini_key, ~/.cupboard_groq_key), never the job agents' keys.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { one, all, run, HOME, botId, owner, getKv, setKv } from './db.mjs';
import * as push from './push.mjs';

const IST = 5.5 * 3600e3, HOUR = 3600e3, DAY = 24 * HOUR;
const NAME = 'Our corner 🌙';
const ACTIVITY_NAME = 'Her activity 👀';
const WIN_START = 22.5, WIN_END = 5;          // 10:30 PM to 5:00 AM (next morning), India time
const MIN_GAP = 12 * HOUR;                    // never two close together

const dayStart = (t) => { const d = new Date(t + IST); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - IST; };
export const inWindow = (t) => { const d = new Date(t + IST), h = d.getUTCHours() + d.getUTCMinutes() / 60; return h >= WIN_START || h < WIN_END; };

// A random moment inside the first night-window that ends after `from`, at least `from`. `early`: only the first
// `early` ms of that window (used for a message that should go out as soon as the night begins).
export function nextSlot(from = Date.now(), rand = Math.random, early = 0) {
  for (let k = -1; k < 3; k++) {
    const start = dayStart(from) + k * DAY + WIN_START * HOUR, end = start + (24 - WIN_START + WIN_END) * HOUR;
    if (end <= from) continue;
    const lo = Math.max(start, from), hi = early ? Math.min(end, lo + early) : end;
    return Math.round(lo + rand() * Math.max(0, hi - lo));
  }
}
// Monday 00:00 (India time) of the week containing t.
const weekStart = (t) => { const s0 = dayStart(t); return s0 - ((new Date(s0 + IST).getUTCDay() + 6) % 7) * DAY; };
// `per` distinct random nights of the week that holds `from` (a later week if this one has no night left), each at a
// random moment in that night's 10:30 PM to 5 AM window and not before `from`. Sorted.
export function planWeek(from, per = 1, rand = Math.random) {
  per = Math.min(7, Math.max(1, per));
  for (let w = weekStart(from), tries = 0; tries < 3; w += 7 * DAY, tries++) {
    const pool = [];
    for (let d = 0; d < 7; d++) { const start = w + d * DAY + WIN_START * HOUR, end = start + (24 - WIN_START + WIN_END) * HOUR; if (end > from + 60e3) pool.push([Math.max(start, from), end]); }
    if (!pool.length) continue;
    const times = [];
    while (times.length < per && pool.length) { const [lo, hi] = pool.splice(Math.floor(rand() * pool.length), 1)[0]; times.push(Math.round(lo + rand() * (hi - lo))); }
    return times.sort((a, b) => a - b);
  }
}
const fmtTime = (t) => new Date(t).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

const keyOf = (f) => { try { return readFileSync(join(HOME, f), 'utf8').trim(); } catch { return ''; } };
const PROVIDERS = () => [
  { name: 'gemini', key: keyOf('.cupboard_gemini_key'), url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    models: ['gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-flash-lite-latest'], extra: { reasoning_effort: 'low' } },
  { name: 'groq', key: keyOf('.cupboard_groq_key'), url: 'https://api.groq.com/openai/v1/chat/completions',
    models: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'], extra: { reasoning_effort: 'low', include_reasoning: false } },
].filter((p) => p.key).concat(process.env.CUPBOARD_AI_TEST_URL ? [{ name: 'test', key: 'test', url: process.env.CUPBOARD_AI_TEST_URL, models: ['test'], extra: {} }] : []);

export function install({ postMessage, updateMessage, log, botConv }) {
  const jget = (k, d) => { try { return JSON.parse(getKv(k)) ?? d; } catch { return d; } };
  const partnerId = () => Number(getKv('love_partner')) || null;

  function ensureChat() {
    const o = owner(), p = partnerId();
    if (!o || !p) return null;
    const id = Number(getKv('love_conv'));
    if (id && one('SELECT 1 FROM convs WHERE id = ?', id)) return id;
    const now = Date.now();
    const conv = Number(run("INSERT INTO convs(kind, name, created_by, created) VALUES('group', ?, ?, ?)", NAME, o.id, now).lastInsertRowid);
    run('INSERT INTO members(conv_id, user_id) VALUES(?, ?)', conv, p);      // hers alone
    setKv('love_conv', conv); setKv('love_private', '1');
    log(`notes chat ${conv} created`);
    return conv;
  }

  // Guman's own chat where her actions show up (only he is in it).
  function activityChat() {
    const o = owner();
    if (!o) return null;
    const id = Number(getKv('love_activity_conv'));
    if (id && one('SELECT 1 FROM convs WHERE id = ?', id)) return id;
    const now = Date.now();
    const conv = Number(run("INSERT INTO convs(kind, name, created_by, created) VALUES('group', ?, ?, ?)", ACTIVITY_NAME, o.id, now).lastInsertRowid);
    run('INSERT INTO members(conv_id, user_id) VALUES(?, ?)', conv, o.id);
    run("INSERT INTO messages(conv_id, user_id, kind, text, extra, created) VALUES(?, ?, 'card', ?, ?, ?)", conv, botId(),
      'When she reads one of your notes, taps a button, reacts or writes back in her chat, it shows up here, and you get a notification.\n' +
      'Her chat itself is hers alone: you are not in it.', JSON.stringify({ title: '👀 Her activity' }), now);
    setKv('love_activity_conv', conv);
    log(`notes activity chat ${conv} created`);
    return conv;
  }

  // A chat made earlier with both of them in it: take Guman out, once.
  if (getKv('love_private') !== '1' && Number(getKv('love_conv')) && owner()) {
    run('DELETE FROM members WHERE conv_id = ? AND user_id = ?', Number(getKv('love_conv')), owner().id);
    setKv('love_private', '1');
    log('notes chat is now hers alone');
  }

  // ----- writing a new note -----
  async function generate() {
    const left = Math.ceil((Date.UTC(2026, 11, 12) - IST - Date.now()) / DAY);
    const recent = jget('love_recent', []);
    const system = `You write ONE short note from Guman to his fiancée Vertika. It pops up on her phone late at night (10:30 PM to 5 AM): it can be a gentle goodnight, or something warm to wake up to.
Say something true-sounding and kind about who she is (her kindness, strength, patience, humour, how hard she works, how she cares about people) and that he is lucky to have her.
Rules: 1 to 3 sentences, at most 45 words. First person ("I") speaking to "you". Sincere and natural, not cheesy; avoid clichés like "my everything" or "light of my life".
At most one emoji. Do not invent specific events or facts about her day. No pet names, no hashtags, no quotation marks, no sign-off.
Their wedding is on 12 December 2026 (${left > 0 ? `${left} days away` : 'soon'}): mention it in about one note in four, not more.
Write it in simple English; about one note in four may be in natural Hinglish (Roman script).${getKv('love_style') ? `\nGuman's own steer for how these should sound: ${getKv('love_style')}` : ''}
Output ONLY the note text.`;
    const user = recent.length ? `Notes already sent (do not repeat their ideas, images or openings):\n${recent.map((n) => `- ${n}`).join('\n')}\n\nWrite a new one.` : 'Write the first one.';
    for (const p of PROVIDERS()) {
      for (const model of p.models) {
        try {
          const r = await fetch(p.url, { method: 'POST', headers: { Authorization: `Bearer ${p.key}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(45000),
            body: JSON.stringify({ model, temperature: 1, max_tokens: 400, ...p.extra, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }) });
          if (!r.ok) { log(`notes ${p.name}/${model} ${r.status}`); continue; }
          let t = ((await r.json()).choices?.[0]?.message?.content || '').trim().replace(/^["“'`*_\s]+|["”'`*_\s]+$/g, '').replace(/\s*\n+\s*/g, ' ');
          if (t.length < 15 || t.length > 320) { log(`notes ${p.name}/${model}: unusable (${t.length} chars)`); continue; }
          return t;
        } catch (e) { log(`notes ${p.name}/${model}: ${e.message}`); }
      }
    }
    return null;
  }
  const remember = (text) => setKv('love_recent', JSON.stringify([...jget('love_recent', []), text].slice(-14)));

  // ----- delivering -----
  async function deliver({ text, title = '💌 A note for you', pushTitle = '💌 A note for you', ask = null }) {
    const conv = ensureChat(), p = partnerId();
    if (!conv || !p) throw new Error('partner not set');
    return postMessage(conv, botId(), { kind: 'card', text, extra: { title, love: true, ...(ask ? { actions: ask } : {}) } },
      { pushOnly: [p], pushAs: { title: pushTitle, body: text.replace(/\n+/g, ' ').slice(0, 170) } });
  }
  // Guman's own words first (oldest first), word for word; otherwise a freshly written one.
  async function nextText() {
    const custom = jget('love_custom', []);
    if (custom.length) { const text = custom.shift(); setKv('love_custom', JSON.stringify(custom)); return text; }
    const text = await generate();
    if (text) remember(text);
    return text;
  }
  const perWeek = () => Math.min(7, Math.max(1, Number(getKv('love_perweek')) || 1));
  // Plan the week that holds `from` (or the next one with a night left); love_next is its first moment.
  function plan(from = Date.now() + MIN_GAP) {
    const times = planWeek(from, perWeek());
    setKv('love_plan', JSON.stringify({ week: weekStart(times[0]), times }));
    setKv('love_next', times[0]);
    return times[0];
  }
  // After a note went out: the rest of this week's plan, or a fresh plan for the following week.
  function afterSend() {
    const p = jget('love_plan', null), rest = (p?.times || []).filter((t) => t > Date.now() + 60e3);
    if (rest.length) { setKv('love_plan', JSON.stringify({ week: p.week, times: rest })); setKv('love_next', rest[0]); return; }
    plan((p?.week || weekStart(Date.now())) + 7 * DAY);
  }
  const schedule = plan;

  async function tick() {
    if (getKv('love_paused') === '1' || !partnerId() || !owner()) return;
    // A message Guman asked to hold until the night begins.
    const q = jget('love_queue', []);
    if (q.length && Date.now() >= q[0].due) {
      const item = q.shift(); setKv('love_queue', JSON.stringify(q));
      await deliver({ text: item.text, ask: item.ask, title: item.title, pushTitle: item.pushTitle });
      return;
    }
    const next = Number(getKv('love_next'));
    if (!next) { plan(); return; }
    if (Date.now() < next) return;
    if (!inWindow(Date.now())) { setKv('love_next', nextSlot(Date.now())); return; }   // e.g. the server was off: wait for the next night
    const text = await nextText();
    if (!text) {                                                            // the AI is busy: try again soon, or tomorrow night
      const retry = Date.now() + 25 * 60e3;
      setKv('love_next', inWindow(retry) ? retry : nextSlot(Date.now() + MIN_GAP));
      return;
    }
    await deliver({ text });
    afterSend();
  }
  if (partnerId()) activityChat();
  setInterval(() => tick().catch((e) => log('notes', e.message)), 60e3);
  setTimeout(() => tick().catch(() => {}), 5000);

  // A one-off message from the server's own voice, held until the night window opens (or sent at once with now: true).
  async function send({ text, title, pushTitle, ask, now = false }) {
    if (now) {
      const msg = await deliver({ text, title, pushTitle, ask });
      if (!Number(getKv('love_next'))) plan();                             // the weekly notes start counting from here
      return msg;
    }
    const q = jget('love_queue', []);
    const due = nextSlot(Date.now(), Math.random, 40 * 60e3);
    q.push({ text, title, pushTitle, ask, due }); setKv('love_queue', JSON.stringify(q));
    if (!Number(getKv('love_next'))) plan();
    return { queued: due };
  }

  // ----- what she does here, shown to Guman: a push to his phone and a short history ("love activity") -----
  const isHer = (me, convId) => me.id === partnerId() && convId === Number(getKv('love_conv'));
  // A line in Guman's "Her activity" chat (tapping the notification opens it), plus a short history for "love activity".
  function activity(text) {
    const o = owner(); if (!o) return;
    const list = jget('love_activity', []); list.push({ at: Date.now(), text }); setKv('love_activity', JSON.stringify(list.slice(-30)));
    const conv = activityChat();
    if (!conv) return;
    postMessage(conv, botId(), { kind: 'text', text }, { pushAs: { title: `💌 ${text.slice(0, 70)}`, body: 'Her activity' } })
      .catch((e) => log('notes activity', e.message));
    log(`notes activity: ${text}`);
  }
  // She opened the chat and read notes (once per note).
  function onRead(me, convId, upTo) {
    if (!isHer(me, convId)) return;
    const rows = all("SELECT id, text, extra FROM messages WHERE conv_id = ? AND user_id = ? AND id <= ? AND kind = 'card' ORDER BY id", convId, botId(), upTo);
    let n = 0;
    for (const m of rows) {
      if (!m.extra || !JSON.parse(m.extra).love || getKv(`love_read:${m.id}`)) continue;
      setKv(`love_read:${m.id}`, '1'); n++;
    }
    if (n) activity(`${me.name.split(' ')[0]} read ${n === 1 ? 'your note' : `${n} of your notes`}`);
  }
  function onReact(me, row, emoji) {
    if (!isHer(me, row.conv_id) || !emoji) return;
    activity(`${me.name.split(' ')[0]} reacted ${emoji} to your note`);
  }
  // What she writes in her chat reaches him too (the notes are his, so a reply is meant for him).
  function onMessage(me, convId, text) { if (isHer(me, convId)) activity(`${me.name.split(' ')[0]} wrote: ${String(text).replace(/\s+/g, ' ').slice(0, 300)}`); }

  // The buttons on the "shall I tell him?" card.
  async function action(me, row, act) {
    const first = me.name.split(' ')[0];
    if (act === 'tell') {
      activity(`${first} tapped "Yes, tell him": she is thinking of you and will call you soon 📞`);
      return updateMessage(row.id, { done: 'Told him 💌', actions: [] });
    }
    if (act === 'later') { activity(`${first} tapped "Not now" (she'll surprise you 😉)`); return updateMessage(row.id, { done: 'Okay, a surprise then 😉', actions: [] }); }
    throw new Error('Unknown action.');
  }

  // Guman's commands, typed in his own S20 chat. Returns the bot's answer, or null if it is not one of these.
  async function command(text) {
    const t = String(text).trim();
    let m;
    if ((m = /^love\s*:\s*([\s\S]{3,500})$/i.exec(t))) {
      const custom = jget('love_custom', []); custom.push(m[1].trim()); setKv('love_custom', JSON.stringify(custom.slice(-50)));
      return `💌 Saved. It goes out word for word as the next weekly note (${custom.length} of your own waiting; yours go before the AI's). Say "love now" to send one right away.`;
    }
    if ((m = /^love\s+style\s*:\s*([\s\S]{3,300})$/i.exec(t))) { setKv('love_style', m[1].trim()); return `✅ Got it. The AI will write like this from now on: "${m[1].trim()}"`; }
    if (/^love\s+style\s*:?\s*(clear|reset|none)$/i.test(t)) { setKv('love_style', ''); return '✅ Back to the default style.'; }
    if ((m = /^love\s+name\s*:\s*(.{1,40})$/i.exec(t))) {
      const conv = ensureChat();
      if (!conv) return 'Not set up yet.';
      run('UPDATE convs SET name = ? WHERE id = ?', m[1].trim(), conv);
      return `✅ The chat is now called "${m[1].trim()}". (She sees the new name after she reopens the app.)`;
    }
    if ((m = /^love\s+per\s*week\s*:?\s*(\d)$/i.exec(t))) {
      const n = Math.min(7, Math.max(1, Number(m[1]))); setKv('love_perweek', n); const next = plan(Date.now() + MIN_GAP);
      return `✅ ${n} note${n > 1 ? 's' : ''} a week, on random days between 10:30 PM and 5 AM. Next one around ${fmtTime(next)}.`;
    }
    if (/^love\s+now$/i.test(t)) {
      const text2 = await nextText();
      if (!text2) return 'The AI is busy right now. Try again in a few minutes.';
      await deliver({ text: text2 });
      return `💌 Sent her one just now:\n"${text2}"`;
    }
    if (/^love\s+activity$/i.test(t)) {
      const list = jget('love_activity', []).slice(-10).reverse();
      return list.length ? `👀 What she did lately (it also appears in your "Her activity" chat):\n${list.map((a) => `• ${fmtTime(a.at)}: ${a.text}`).join('\n')}` : 'Nothing yet. Anything she does in the chat (reads a note, taps a button, reacts, replies) shows up here and as a notification.';
    }
    if (/^love\s+pause$/i.test(t)) { setKv('love_paused', '1'); return '⏸ Notes for her are paused. Say "love resume" to start again.'; }
    if (/^love\s+resume$/i.test(t)) { setKv('love_paused', ''); if (!Number(getKv('love_next')) || Number(getKv('love_next')) < Date.now()) plan(); return `▶️ Notes for her are on. Next one around ${fmtTime(Number(getKv('love_next')))}.`; }
    if (/^love\s+status$/i.test(t)) {
      const custom = jget('love_custom', []), q = jget('love_queue', []);
      const pl = jget('love_plan', null);
      return `💌 Notes for her are ${getKv('love_paused') === '1' ? 'PAUSED' : 'on'}: ${perWeek()} new AI-written note${perWeek() > 1 ? 's' : ''} a week, on random days between 10:30 PM and 5 AM. ` +
        `Next around ${getKv('love_next') ? fmtTime(Number(getKv('love_next'))) : 'not scheduled'}${pl?.times?.length > 1 ? ` (this week's others: ${pl.times.slice(1).map(fmtTime).join(', ')})` : ''}. Your own notes waiting: ${custom.length}. ` +
        `${q.length ? `One special message is held until ${fmtTime(q[0].due)}. ` : ''}${getKv('love_style') ? `Style: "${getKv('love_style')}".` : 'Style: default.'}`;
    }
    if (/^love\b/i.test(t) && t.length < 12) return 'Notes for her: "love: <your words>" saves one · "love now" · "love activity" · "love pause" · "love resume" · "love status" · "love per week: 2" · "love style: <how it should sound>" · "love name: <chat name>".';
    return null;
  }

  return { ensureChat, deliver, send, action, command, schedule, partnerId, tick, generate, onRead, onReact, onMessage };
}
