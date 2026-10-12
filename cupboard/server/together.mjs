// "Together": shared lists (groceries, packing, to-dos) and a shared calendar with reminders.
// Every list and event belongs to a chat; that chat's members share it (the person's own bot chat = "just me").
// Reminders arrive as a card in the chat, sent by the bot, with a push even when the chat is muted.
// "remind us Sunday 10am call Mom" typed in a chat creates one (Groq reads the time; a simple parser is the fallback).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { one, all, run, HOME, botId } from './db.mjs';

const IST = 5.5 * 3600e3, DAY = 86400e3;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const REPEATS = ['daily', 'weekly', 'monthly'];
const EVERY = { daily: 'every day', weekly: 'every week', monthly: 'every month' };

// Dates are shown in India time whatever the server's clock zone.
export function fmt(t, allDay) {
  const d = new Date(t + IST);
  const date = `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  if (allDay) return date;
  const hh = d.getUTCHours(), mm = d.getUTCMinutes();
  return `${date}, ${hh % 12 || 12}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`;
}
const istMidnight = (t) => { const d = new Date(t + IST); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - IST; };
function advance(t, repeat) {
  if (repeat === 'daily') return t + DAY;
  if (repeat === 'weekly') return t + 7 * DAY;
  const d = new Date(t + IST); d.setUTCMonth(d.getUTCMonth() + 1); return d.getTime() - IST;
}
// Reminder time from "minutes before" (null = no reminder). All-day events remind at 09:00 on the day (or N days before).
const remindAt = (starts, allDay, remind) => (remind == null || remind === '' || Number(remind) < 0 ? null : (allDay ? starts + 9 * 3600e3 : starts) - Number(remind) * 60e3);

const listJson = (l) => ({ id: l.id, conv: l.conv_id, title: l.title, emoji: l.emoji, by: l.created_by, created: l.created, updated: l.updated, archived: !!l.archived,
  items: all('SELECT * FROM list_items WHERE list_id = ? ORDER BY id', l.id).map((i) => ({ id: i.id, text: i.text, done: !!i.done, doneBy: i.done_by, doneAt: i.done_at, by: i.created_by })) });
const eventJson = (e) => ({ id: e.id, conv: e.conv_id, title: e.title, starts: e.starts, allDay: !!e.all_day, remindAt: e.remind_at, forAll: !!e.for_all,
  kind: e.kind, repeat: e.repeat, by: e.created_by, sent: !!e.sent });

export function install({ postMessage, updateMessage, emit, memberIds, canSee, readJson, send, err, log, botConv, convTitle }) {
  const first = (u) => u.name.split(' ')[0];
  const getList = (me, id) => { const l = one('SELECT * FROM lists WHERE id = ?', id); if (!l || !canSee(me, l.conv_id)) throw err(404, 'List not found.'); return l; };
  const getEvent = (me, id) => {
    const e = one('SELECT * FROM events WHERE id = ?', id);
    if (!e || !canSee(me, e.conv_id) || (!e.for_all && e.created_by !== me.id)) throw err(404, 'Event not found.');
    return e;
  };
  const touch = (listId) => run('UPDATE lists SET updated = ? WHERE id = ?', Date.now(), listId);
  const emitList = (listId, convId) => {
    const l = one('SELECT * FROM lists WHERE id = ?', listId);
    const data = l ? { list: listJson(l) } : { id: listId, gone: true };
    for (const uid of memberIds(l?.conv_id ?? convId)) emit(uid, 'list', data);
  };
  const audience = (e) => (e.for_all ? memberIds(e.conv_id) : [e.created_by]);
  const emitEvent = (e, gone) => { for (const uid of audience(e)) emit(uid, 'event', gone ? { id: e.id, gone: true } : { event: eventJson(one('SELECT * FROM events WHERE id = ?', e.id)) }); };
  const myConv = (me, id) => { id = Number(id); if (!id || !canSee(me, id)) throw err(400, 'Pick a chat to share it with.'); return id; };
  const cleanTitle = (t, max = 120) => { t = String(t || '').trim().replace(/\s+/g, ' ').slice(0, max); if (!t) throw err(400, 'Give it a name.'); return t; };

  // ---------- event fields from a request body ----------
  function eventFields(b, me, old) {
    const allDay = b.allDay !== undefined ? !!b.allDay : !!old?.all_day;
    let starts = b.starts !== undefined ? Number(b.starts) : old?.starts;
    if (!Number.isFinite(starts) || starts < Date.UTC(2020, 0, 1) || starts > Date.now() + 5 * 365 * DAY) throw err(400, 'Pick a date.');
    if (allDay) starts = istMidnight(starts);
    const repeat = b.repeat !== undefined ? (REPEATS.includes(b.repeat) ? b.repeat : null) : old?.repeat ?? null;
    let remind_at = b.remind !== undefined ? remindAt(starts, allDay, b.remind) : old?.remind_at ?? null;
    if (b.remind === undefined && old && (b.starts !== undefined || b.allDay !== undefined) && old.remind_at != null) {
      remind_at = (allDay ? starts + 9 * 3600e3 : starts) - ((old.all_day ? old.starts + 9 * 3600e3 : old.starts) - old.remind_at);   // keep the same lead time
    }
    const forAll = b.who !== undefined ? b.who !== 'me' : old ? !!old.for_all : true;
    const conv = b.conv !== undefined ? myConv(me, b.conv) : old.conv_id;
    return { title: cleanTitle(b.title ?? old?.title), starts, all_day: allDay ? 1 : 0, remind_at, repeat, for_all: forAll ? 1 : 0, conv_id: conv,
      kind: b.kind === 'reminder' || (!b.kind && old?.kind === 'reminder') ? 'reminder' : 'event',
      sent: remind_at != null && remind_at < Date.now() - 60e3 ? 1 : 0 };   // a reminder time already past is not sent late
  }

  // ---------- routes (all signed in) ----------
  async function route(req, res, path, query, me) {
    const M = req.method;
    let m;
    if (M === 'GET' && path === '/api/together') {
      const convIds = all('SELECT conv_id FROM members WHERE user_id = ?', me.id).map((r) => r.conv_id);
      const q = convIds.map(() => '?').join(',') || 'NULL';
      const lists = all(`SELECT * FROM lists WHERE conv_id IN (${q}) ORDER BY archived, updated DESC`, ...convIds).map(listJson);
      const events = all(`SELECT * FROM events WHERE conv_id IN (${q}) AND (for_all = 1 OR created_by = ?) AND (starts > ? OR repeat IS NOT NULL) ORDER BY starts LIMIT 800`,
        ...convIds, me.id, Date.now() - 120 * DAY).map(eventJson);
      const convs = convIds.map((id) => { const c = one('SELECT kind FROM convs WHERE id = ?', id); return { id, kind: c.kind, title: c.kind === 'bot' ? 'Just me' : convTitle(id, me) }; })
        .sort((a, b) => (a.kind === 'bot') - (b.kind === 'bot') || (a.kind === 'group') - (b.kind === 'group'));
      return send(res, 200, { lists, events, convs }), true;
    }

    // ----- lists -----
    if (M === 'POST' && path === '/api/lists') {
      const b = await readJson(req, 4000);
      const conv = myConv(me, b.conv);
      if (one('SELECT count(*) AS n FROM lists WHERE conv_id = ?', conv).n >= 100) throw err(400, 'That chat already has 100 lists. Delete some first.');
      const now = Date.now();
      const { lastInsertRowid: id } = run('INSERT INTO lists(conv_id, title, emoji, created_by, created, updated) VALUES(?,?,?,?,?,?)',
        conv, cleanTitle(b.title, 60), String(b.emoji || '').slice(0, 8) || null, me.id, now, now);
      emitList(Number(id));
      return send(res, 200, { list: listJson(one('SELECT * FROM lists WHERE id = ?', id)) }), true;
    }
    if ((m = /^\/api\/lists\/(\d+)(\/items|\/clear|\/share)?$/.exec(path))) {
      const l = getList(me, Number(m[1])), sub = m[2] || '';
      if (M === 'GET' && !sub) return send(res, 200, { list: listJson(l) }), true;
      if (M === 'DELETE' && !sub) {
        run('DELETE FROM list_items WHERE list_id = ?', l.id); run('DELETE FROM lists WHERE id = ?', l.id);
        emitList(l.id, l.conv_id);
        return send(res, 200, { ok: true }), true;
      }
      if (M === 'POST' && !sub) {
        const b = await readJson(req, 2000);
        if (b.title !== undefined) run('UPDATE lists SET title = ? WHERE id = ?', cleanTitle(b.title, 60), l.id);
        if (b.emoji !== undefined) run('UPDATE lists SET emoji = ? WHERE id = ?', String(b.emoji || '').slice(0, 8) || null, l.id);
        if (b.archived !== undefined) run('UPDATE lists SET archived = ? WHERE id = ?', b.archived ? 1 : 0, l.id);
        touch(l.id); emitList(l.id);
        return send(res, 200, { list: listJson(one('SELECT * FROM lists WHERE id = ?', l.id)) }), true;
      }
      if (M === 'POST' && sub === '/items') {                // one per line, so a pasted list adds every item
        const b = await readJson(req, 20_000);
        const lines = String(b.text || '').split('\n').map((s) => s.trim().replace(/^[-*•☐✓✔]\s*/, '').slice(0, 200)).filter(Boolean).slice(0, 50);
        if (!lines.length) throw err(400, 'Type an item.');
        if (one('SELECT count(*) AS n FROM list_items WHERE list_id = ?', l.id).n + lines.length > 300) throw err(400, 'A list holds up to 300 items. Clear the ticked ones first.');
        const now = Date.now();
        for (const text of lines) run('INSERT INTO list_items(list_id, text, created_by, created) VALUES(?,?,?,?)', l.id, text, me.id, now);
        touch(l.id); emitList(l.id);
        return send(res, 200, { list: listJson(one('SELECT * FROM lists WHERE id = ?', l.id)) }), true;
      }
      if (M === 'POST' && sub === '/clear') {                // remove ticked items
        run('DELETE FROM list_items WHERE list_id = ? AND done = 1', l.id);
        touch(l.id); emitList(l.id);
        return send(res, 200, { list: listJson(one('SELECT * FROM lists WHERE id = ?', l.id)) }), true;
      }
      if (M === 'POST' && sub === '/share') {                // a live card in the list's chat: ticks show up there too
        const c = one('SELECT kind FROM convs WHERE id = ?', l.conv_id);
        if (c.kind === 'bot') throw err(400, 'This list is just yours. Make it in a chat with someone to share it.');
        const msg = await postMessage(l.conv_id, me.id, { kind: 'card', text: `${l.emoji ? l.emoji + ' ' : ''}${l.title}`, extra: { title: '📝 List', list: l.id } });
        return send(res, 200, { msg }), true;
      }
    }
    if ((m = /^\/api\/items\/(\d+)$/.exec(path)) && (M === 'POST' || M === 'DELETE')) {
      const it = one('SELECT * FROM list_items WHERE id = ?', Number(m[1]));
      if (!it) throw err(404, 'That item is gone.');
      const l = getList(me, it.list_id);
      if (M === 'DELETE') run('DELETE FROM list_items WHERE id = ?', it.id);
      else {
        const b = await readJson(req, 2000);
        if (b.done !== undefined) run('UPDATE list_items SET done = ?, done_by = ?, done_at = ? WHERE id = ?', b.done ? 1 : 0, b.done ? me.id : null, b.done ? Date.now() : null, it.id);
        if (b.text !== undefined) run('UPDATE list_items SET text = ? WHERE id = ?', cleanTitle(b.text, 200), it.id);
      }
      touch(l.id); emitList(l.id);
      return send(res, 200, { list: listJson(one('SELECT * FROM lists WHERE id = ?', l.id)) }), true;
    }

    // ----- calendar -----
    if (M === 'POST' && path === '/api/events') {
      const b = await readJson(req, 4000);
      if (one('SELECT count(*) AS n FROM events WHERE created_by = ? AND starts > ?', me.id, Date.now()).n >= 500) throw err(400, 'Too many upcoming events.');
      const f = eventFields(b, me, null);
      const { lastInsertRowid: id } = run('INSERT INTO events(conv_id, title, starts, all_day, remind_at, for_all, kind, repeat, created_by, created, sent) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        f.conv_id, f.title, f.starts, f.all_day, f.remind_at, f.for_all, f.kind, f.repeat, me.id, Date.now(), f.sent);
      const e = one('SELECT * FROM events WHERE id = ?', id);
      emitEvent(e);
      return send(res, 200, { event: eventJson(e) }), true;
    }
    if ((m = /^\/api\/events\/(\d+)$/.exec(path))) {
      const e = getEvent(me, Number(m[1]));
      if (M === 'DELETE') { run('DELETE FROM events WHERE id = ?', e.id); emitEvent(e, true); return send(res, 200, { ok: true }), true; }
      if (M === 'POST') {
        const f = eventFields(await readJson(req, 4000), me, e);
        run('UPDATE events SET conv_id = ?, title = ?, starts = ?, all_day = ?, remind_at = ?, for_all = ?, kind = ?, repeat = ?, sent = ? WHERE id = ?',
          f.conv_id, f.title, f.starts, f.all_day, f.remind_at, f.for_all, f.kind, f.repeat, f.sent, e.id);
        if (e.conv_id !== f.conv_id || e.for_all !== f.for_all) emitEvent(e, true);   // people who no longer share it
        emitEvent(e);
        return send(res, 200, { event: eventJson(one('SELECT * FROM events WHERE id = ?', e.id)) }), true;
      }
    }
    return false;
  }

  // ---------- buttons on reminder cards ----------
  async function action(me, row, act) {
    const extra = row.extra ? JSON.parse(row.extra) : {};
    const e = one('SELECT * FROM events WHERE id = ?', Number(extra.event));
    if (act === 'cancel') {
      if (e && (e.for_all || e.created_by === me.id)) { run('DELETE FROM events WHERE id = ?', e.id); emitEvent(e, true); }
      return updateMessage(row.id, { done: e ? `Cancelled by ${first(me)}` : 'Already cancelled' });
    }
    if (act === 'done') return updateMessage(row.id, { done: `Done · ${first(me)}` });
    if (act === 'snooze') {
      const at = Date.now() + 3600e3;
      if (e && !e.repeat) { run('UPDATE events SET remind_at = ?, sent = 0 WHERE id = ?', at, e.id); emitEvent(e); }
      else {                                                 // a repeating one has already moved on: a one-off copy
        const src = e || { conv_id: row.conv_id, title: String(row.text || 'Reminder').split('\n')[0], for_all: 1 };
        const { lastInsertRowid: id } = run("INSERT INTO events(conv_id, title, starts, remind_at, for_all, kind, created_by, created) VALUES(?,?,?,?,?,'reminder',?,?)",
          src.conv_id, src.title, at, at, src.for_all, me.id, Date.now());
        emitEvent(one('SELECT * FROM events WHERE id = ?', id));
      }
      return updateMessage(row.id, { done: `Snoozed to ${fmt(at).split(', ')[1]} by ${first(me)}` });
    }
    throw err(400, 'Unknown action.');
  }

  // ---------- "remind us …" / "remind me …" typed in a chat ----------
  const REMIND = /^remind\s+(us|me)\b[\s,:]*(.*)$/is;
  const isRemind = (text) => REMIND.test(text.trim());
  async function fromChat(me, conv, text) {
    const [, who, rest] = REMIND.exec(text.trim());
    const now = Date.now();
    const p = (await llmParse(rest, now).catch((e) => { log('remind llm', e.message); return null; })) || roughParse(rest, now);
    if (!p) {
      return postMessage(conv.id, botId(), { kind: 'card', text: 'I couldn\'t tell when. Try "remind us Sunday 10am call Mom" or "remind me in 2 hours to stretch".', extra: { title: '⏰ Reminder' } });
    }
    const forAll = who.toLowerCase() === 'us' && conv.kind !== 'bot' ? 1 : 0;
    const { lastInsertRowid: id } = run("INSERT INTO events(conv_id, title, starts, all_day, remind_at, for_all, kind, repeat, created_by, created) VALUES(?,?,?,0,?,?,'reminder',?,?,?)",
      conv.id, p.title, p.at, p.at, forAll, p.repeat, me.id, now);
    emitEvent(one('SELECT * FROM events WHERE id = ?', id));
    const whom = forAll ? (conv.kind === 'group' ? 'everyone here' : 'both of you') : conv.kind === 'bot' ? 'you' : `just ${first(me)}`;
    return postMessage(conv.id, botId(), { kind: 'card', text: `${p.title}\n${fmt(p.at)}${p.repeat ? ` · ${EVERY[p.repeat]}` : ''} · ${whom}`,
      extra: { title: '⏰ Reminder set', event: Number(id), actions: [{ id: 'cancel', label: 'Cancel' }], link: { label: 'Calendar', path: '/together/calendar' } } },
      { pushAs: { title: `⏰ ${first(me)} set a reminder`, body: `${p.title} · ${fmt(p.at)}` } });
  }

  // ---------- the scheduler: due reminders become chat cards + push ----------
  async function tick() {
    const now = Date.now();
    for (const e of all('SELECT * FROM events WHERE sent = 0 AND remind_at IS NOT NULL AND remind_at <= ? ORDER BY remind_at LIMIT 50', now)) {
      try {
        const owner = one('SELECT * FROM users WHERE id = ? AND active = 1', e.created_by);
        const late = now - e.remind_at > 15 * 60e3;
        // Shared ones go to the chat they belong to; "just me" ones to the person's own bot chat.
        const convId = e.for_all || !owner ? e.conv_id : botConv(owner);
        const at = e.kind === 'reminder' ? '' : `\n${fmt(e.starts, e.all_day)}`;
        await postMessage(convId, botId(), { kind: 'card', text: `${e.title}${at}${late ? `\n(late: this was due ${fmt(e.remind_at)})` : ''}`,
          extra: { title: '⏰ Reminder', event: e.id, actions: [{ id: 'done', label: '✓ Done', style: 'go' }, { id: 'snooze', label: 'In 1 hour' }] } },
          { force: true, pushAs: { title: `⏰ ${e.title}`, body: e.kind === 'reminder' ? 'Reminder' : fmt(e.starts, e.all_day) } });
        if (e.repeat) {                                      // move a repeating one to its next time in the future
          let s = e.starts, r = e.remind_at;
          while (r <= now) { const n = advance(s, e.repeat); r += n - s; s = n; }
          run('UPDATE events SET starts = ?, remind_at = ? WHERE id = ?', s, r, e.id);
        } else run('UPDATE events SET sent = 1 WHERE id = ?', e.id);
        emitEvent(e);
      } catch (x) { log('reminder', e.id, x.message); run('UPDATE events SET sent = 1 WHERE id = ?', e.id); }
    }
  }
  setInterval(() => tick().catch((x) => log('reminders', x.message)), 20e3);
  setTimeout(() => tick().catch(() => {}), 3000);

  // Calendar entries kept in step with other features (wedding functions, vendor payments): create or update, and remove.
  function setEvent(id, { conv, title, starts, allDay = false, remind = 1440, by }) {
    if (allDay) starts = istMidnight(starts);
    const at = remindAt(starts, allDay, remind), sent = at != null && at < Date.now() - 60e3 ? 1 : 0;
    const old = id ? one('SELECT * FROM events WHERE id = ?', id) : null;
    if (old) {
      run('UPDATE events SET conv_id = ?, title = ?, starts = ?, all_day = ?, remind_at = ?, sent = ? WHERE id = ?', conv, title.slice(0, 120), starts, allDay ? 1 : 0, at, sent, id);
      if (old.conv_id !== conv) emitEvent(old, true);
    } else {
      id = Number(run("INSERT INTO events(conv_id, title, starts, all_day, remind_at, for_all, kind, created_by, created, sent) VALUES(?,?,?,?,?,1,'event',?,?,?)",
        conv, title.slice(0, 120), starts, allDay ? 1 : 0, at, by, Date.now(), sent).lastInsertRowid);
    }
    emitEvent(one('SELECT * FROM events WHERE id = ?', id));
    return id;
  }
  function removeEvent(id) {
    const e = id ? one('SELECT * FROM events WHERE id = ?', id) : null;
    if (e) { run('DELETE FROM events WHERE id = ?', e.id); emitEvent(e, true); }
  }

  // For the assistant: a reminder in a chat, and items added to a list found by name (or a new list).
  function addReminder({ conv, title, at, forAll = true, repeat = null, by }) {
    const id = Number(run("INSERT INTO events(conv_id, title, starts, all_day, remind_at, for_all, kind, repeat, created_by, created) VALUES(?,?,?,0,?,?,'reminder',?,?,?)",
      conv, String(title).slice(0, 120), at, at, forAll ? 1 : 0, REPEATS.includes(repeat) ? repeat : null, by, Date.now()).lastInsertRowid);
    emitEvent(one('SELECT * FROM events WHERE id = ?', id));
    return id;
  }
  function addToList({ convs, conv, name, emoji, items, by }) {
    const q = convs.map(() => '?').join(',');
    let l = one(`SELECT * FROM lists WHERE conv_id IN (${q}) AND lower(title) = lower(?) AND archived = 0 ORDER BY updated DESC`, ...convs, String(name).trim());
    const now = Date.now();
    if (!l) l = one('SELECT * FROM lists WHERE id = ?', run('INSERT INTO lists(conv_id, title, emoji, created_by, created, updated) VALUES(?,?,?,?,?,?)',
      conv, String(name).trim().slice(0, 60) || 'List', emoji ? String(emoji).slice(0, 8) : null, by, now, now).lastInsertRowid);
    for (const t of items.map((x) => String(x).trim().slice(0, 200)).filter(Boolean).slice(0, 50)) run('INSERT INTO list_items(list_id, text, created_by, created) VALUES(?,?,?,?)', l.id, t, by, now);
    touch(l.id); emitList(l.id);
    return l;
  }

  return { route, action, isRemind, fromChat, tick, setEvent, removeEvent, addReminder, addToList };
}

// ---------- reading "Sunday 10am call Mom" ----------
function groqKey() { try { return readFileSync(join(HOME, '.groq_key'), 'utf8').trim(); } catch { return ''; } }
const isoIst = (t) => new Date(t + IST).toISOString().slice(0, 16);
function fromIst(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(s || ''));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - IST : NaN;
}
function sane(p, now) {
  if (!p?.title || !Number.isFinite(p.at)) return null;
  if (p.at <= now - 60e3) { if (p.at > now - DAY && !p.explicitDate) p.at += DAY; else return null; }
  if (p.at > now + 3 * 365 * DAY) return null;
  return { title: p.title.slice(0, 120), at: p.at, repeat: REPEATS.includes(p.repeat) ? p.repeat : null };
}

export async function llmParse(text, now) {
  const key = groqKey();
  if (!key) return null;
  const d = new Date(now + IST);
  const system = `You turn a reminder request into JSON. It is now ${DAYS[d.getUTCDay()]} ${isoIst(now).replace('T', ' ')} in India (IST).
Reply with JSON only: {"ok":true,"title":"...","at":"YYYY-MM-DDTHH:MM","repeat":null}
- title: the thing to do, short, first letter capital, without the date/time words or "to" at the start ("call Mom", "Pay electricity bill").
- at: when, in IST. Only a day given: 09:00 that day. Only a time: the next time it comes. morning 09:00, afternoon 14:00, evening 18:00, tonight/night 21:00.
  "this weekend" = Saturday. "next <weekday>" = that weekday in the coming week. "in 2 hours" = now + 2 hours.
- repeat: "daily", "weekly" or "monthly" if it says every day/week/month/Sunday/etc., else null. For "every Sunday" set at to the next Sunday.
- If there is no day or time at all, reply {"ok":false}.`;
  for (const model of ['openai/gpt-oss-120b', 'openai/gpt-oss-20b']) {
    try {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000),
        body: JSON.stringify({ model, temperature: 0, max_tokens: 300, reasoning_effort: 'low', include_reasoning: false, response_format: { type: 'json_object' },
          messages: [{ role: 'system', content: system }, { role: 'user', content: text.slice(0, 400) }] }),
      });
      if (!r.ok) continue;
      const out = JSON.parse((await r.json()).choices?.[0]?.message?.content || '{}');
      if (out.ok === false) return null;
      return sane({ title: String(out.title || '').trim(), at: fromIst(out.at), repeat: out.repeat, explicitDate: true }, now);
    } catch { /* next model */ }
  }
  return null;
}

// Fallback without the internet: "in 20 min …", "tomorrow 9am …", "sunday at 10 …", "at 18:30 …", "every monday 8am …".
export function roughParse(text, now = Date.now()) {
  let s = ` ${text} `, at = null, repeat = null, explicitDate = false;
  const cut = (re) => { const m = re.exec(s); if (m) s = s.replace(m[0], ' '); return m; };
  let m;
  if ((m = cut(/\bin\s+(an?|\d+(?:\.\d+)?)\s*(m|mins?|minutes?|h|hrs?|hours?|d|days?)\b/i))) {
    const n = /^an?$/i.test(m[1]) ? 1 : Number(m[1]), u = m[2][0].toLowerCase();
    at = now + n * (u === 'm' ? 60e3 : u === 'h' ? 3600e3 : DAY);
  } else {
    const d = new Date(now + IST);
    let day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - IST, dayGiven = false, sameDay = false;
    if ((m = cut(/\bevery\s+(day|week|month)\b/i))) { repeat = { day: 'daily', week: 'weekly', month: 'monthly' }[m[1].toLowerCase()]; }
    if ((m = cut(/\b(today|tonight|tomorrow|tmrw?)\b/i))) { dayGiven = true; explicitDate = true; if (/^tom|^tmr/i.test(m[1])) day += DAY; }
    else if ((m = cut(/\b(?:(every|next|this|on)\s+)?(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/i))) {
      const want = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(m[2].toLowerCase());
      let add = (want - d.getUTCDay() + 7) % 7;
      if (m[1]?.toLowerCase() === 'next' && add === 0) add = 7;
      day += add * DAY; dayGiven = true; explicitDate = true;
      if (add === 0) sameDay = true;                         // "sunday" on a Sunday: later today, or else next week
      if (m[1]?.toLowerCase() === 'every') repeat = 'weekly';
    }
    let hh = null, mm = 0;
    if ((m = cut(/\b(?:at\s+)?(\d{1,2})(?::|\.)(\d{2})\s*(am|pm)?\b/i)) || (m = cut(/\b(?:at\s+)?(\d{1,2})()\s*(am|pm)\b/i)) || (m = cut(/\bat\s+(\d{1,2})()\b/i))) {
      hh = Number(m[1]) % 24; mm = Number(m[2] || 0);
      const ap = m[3]?.toLowerCase();
      if (ap === 'pm' && hh < 12) hh += 12; if (ap === 'am' && hh === 12) hh = 0;
      if (!ap && !m[2] && hh >= 1 && hh <= 7) hh += 12;      // "at 6" means the evening
    } else if ((m = cut(/\b(morning|afternoon|evening|night)\b/i))) hh = { morning: 9, afternoon: 14, evening: 18, night: 21 }[m[1].toLowerCase()];
    else if (/\btonight\b/i.test(text)) hh = 21;
    if (hh == null && !dayGiven && !repeat) return null;
    at = day + (hh ?? 9) * 3600e3 + mm * 60e3;
    if (!dayGiven && at <= now) at += DAY;
    if (sameDay && at <= now) at += 7 * DAY;
  }
  const title = s.replace(/\s+/g, ' ').replace(/^\s*(?:to|on|at|that|about)\s+/i, '').replace(/^\s*(?:to|on|at)\s+/i, '').replace(/\s+(?:on|at|by)\s*$/i, '').trim();
  if (!title) return null;
  return sane({ title: title[0].toUpperCase() + title.slice(1), at, repeat, explicitDate }, now);
}
