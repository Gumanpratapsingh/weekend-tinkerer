// Cupboard: a small WhatsApp-style chat served from the phone. Two listeners, both on localhost only:
//   127.0.0.1:8085  the app's API (nginx proxies /cupboard/api/* here, reached via the "cupboard" Worker)
//   127.0.0.1:8086  internal: other services on the phone (job agent, room watcher, expenses) message the
//                   owner through the "S20" bot. nginx never proxies this port.
// All text is stored and sent as plain text; the web app inserts it as text, never as HTML.
import { createServer } from 'node:http';
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { writeFileSync, statSync, createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import { db, one, all, run, MEDIA, botId, owner } from './db.mjs';
import * as push from './push.mjs';
import { botReply, botAction } from './bot.mjs';

const PORT = 8085, INTERNAL = 8086;
const SESSION_DAYS = 90;
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- http helpers ----------
const err = (status, message) => Object.assign(new Error(message), { status, expose: true });
function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}
function readRaw(req, limit) {
  return new Promise((ok, bad) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) { bad(err(413, 'Too large.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => ok(Buffer.concat(chunks)));
    req.on('error', bad);
  });
}
const readJson = async (req, limit = 16_000) => { const b = await readRaw(req, limit); try { return b.length ? JSON.parse(b) : {}; } catch { throw err(400, 'Bad JSON.'); } };
const visitorIp = (req) => String(req.headers['x-visitor-ip'] || req.headers['cf-connecting-ip'] || 'local');

// ---------- auth ----------
const hashPw = (pw, salt) => scryptSync(String(pw), Buffer.from(salt, 'hex'), 64).toString('hex');
function checkPw(user, pw) {
  if (!user?.hash) return false;
  return timingSafeEqual(Buffer.from(hashPw(pw, user.salt), 'hex'), Buffer.from(user.hash, 'hex'));
}
const attempts = new Map();
const locked = (ip) => { const r = (attempts.get(ip) || []).filter((t) => Date.now() - t < 15 * 60e3); attempts.set(ip, r); return r.length >= 5; };
const fail = (ip) => attempts.set(ip, [...(attempts.get(ip) || []), Date.now()]);

function newSession(userId) {
  const token = randomBytes(32).toString('hex');
  run('INSERT INTO sessions(token, user_id, expires) VALUES(?,?,?)', token, userId, Date.now() + SESSION_DAYS * 86400e3);
  run('DELETE FROM sessions WHERE expires < ?', Date.now());
  return token;
}
const cookie = (token, maxAge) => `cb=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
function userOf(req) {
  const m = /(?:^|;\s*)cb=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  if (!m) return null;
  return one('SELECT u.*, s.token FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires > ? AND u.active = 1', m[1], Date.now()) || null;
}
const publicUser = (u) => u && ({ id: u.id, username: u.username, name: u.name, role: u.role });

function validSignup({ name, username, password }) {
  name = String(name || '').trim(); username = String(username || '').trim().toLowerCase();
  if (!name || name.length > 40) throw err(400, 'Enter your name (up to 40 characters).');
  if (!/^[a-z0-9_.]{3,20}$/.test(username)) throw err(400, 'Username: 3–20 letters, numbers, dots or underscores.');
  if (String(password || '').length < 8) throw err(400, 'Password: at least 8 characters.');
  if (one('SELECT 1 FROM users WHERE username = ?', username)) throw err(409, 'That username is taken.');
  return { name, username, password: String(password) };
}

// ---------- live updates (Server-Sent Events) ----------
const streams = new Map();     // userId -> Set(res)
const activeUntil = new Map(); // userId -> ms; the app pings while it is open and visible
function emit(userId, event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of streams.get(userId) || []) res.write(frame);
}
const isActive = (userId) => (activeUntil.get(userId) || 0) > Date.now();

// ---------- conversations ----------
const memberIds = (convId) => all('SELECT user_id FROM members WHERE conv_id = ?', convId).map((r) => r.user_id);
function canSee(user, convId) {
  return !!one('SELECT 1 FROM members WHERE conv_id = ? AND user_id = ?', convId, user.id);
}
function rowToMsg(m) {
  return { id: m.id, conv: m.conv_id, from: m.user_id, kind: m.kind, text: m.text, duration: m.duration,
    media: m.media ? `/api/media/${m.id}` : null, extra: m.extra ? JSON.parse(m.extra) : null, at: m.created };
}
function convSummary(convId, forUser) {
  const c = one('SELECT * FROM convs WHERE id = ?', convId);
  const people = all(`SELECT u.id, u.name, u.username, u.role, m.last_read FROM members m JOIN users u ON u.id = m.user_id WHERE m.conv_id = ?`, convId);
  const last = one('SELECT * FROM messages WHERE conv_id = ? ORDER BY id DESC LIMIT 1', convId);
  const mine = people.find((p) => p.id === forUser.id);
  const unread = one('SELECT count(*) AS n FROM messages WHERE conv_id = ? AND id > ? AND user_id != ?', convId, mine?.last_read || 0, forUser.id).n;
  const other = people.find((p) => p.id !== forUser.id);
  const title = c.kind === 'group' ? c.name : other?.name || 'Chat';
  return { id: c.id, kind: c.kind, title, people: people.map(({ last_read, ...p }) => ({ ...p, lastRead: last_read })),
    last: last ? rowToMsg(last) : null, unread, created: c.created };
}

/** Save a message and fan it out: live update to every member, push to members who are not looking. */
async function postMessage(convId, fromId, { kind = 'text', text = null, media = null, duration = null, extra = null }) {
  const now = Date.now();
  const { lastInsertRowid: id } = run('INSERT INTO messages(conv_id, user_id, kind, text, media, duration, extra, created) VALUES(?,?,?,?,?,?,?,?)',
    convId, fromId, kind, text, media, duration, extra ? JSON.stringify(extra) : null, now);
  run('UPDATE members SET last_read = ? WHERE conv_id = ? AND user_id = ?', Number(id), convId, fromId);
  const msg = rowToMsg(one('SELECT * FROM messages WHERE id = ?', id));
  const from = one('SELECT name FROM users WHERE id = ?', fromId);
  const conv = one('SELECT * FROM convs WHERE id = ?', convId);
  for (const uid of memberIds(convId)) {
    const u = one('SELECT * FROM users WHERE id = ?', uid);
    if (u.role === 'bot') continue;
    emit(uid, 'msg', { msg, conv: convSummary(convId, u) });
    if (uid !== fromId && !isActive(uid)) {
      const body = kind === 'voice' ? '🎤 Voice note' : (extra?.title ? `${extra.title}: ` : '') + (text || '');
      push.notify(uid, { title: conv.kind === 'group' ? `${from.name} · ${conv.name}` : from.name, body: body.slice(0, 180), url: `/c/${convId}`, tag: `c${convId}` });
    }
  }
  return msg;
}
function updateMessage(id, patch) {
  const m = one('SELECT * FROM messages WHERE id = ?', id);
  const extra = { ...(m.extra ? JSON.parse(m.extra) : {}), ...patch };
  run('UPDATE messages SET extra = ? WHERE id = ?', JSON.stringify(extra), id);
  const msg = rowToMsg({ ...m, extra: JSON.stringify(extra) });
  for (const uid of memberIds(m.conv_id)) emit(uid, 'update', { msg });
  return msg;
}

function botConv(ownerUser) {
  const b = botId();
  const row = one("SELECT c.id FROM convs c JOIN members m ON m.conv_id = c.id WHERE c.kind = 'bot' AND m.user_id = ?", ownerUser.id);
  if (row) return row.id;
  const { lastInsertRowid: id } = run("INSERT INTO convs(kind, name, created_by, created) VALUES('bot', 'S20', ?, ?)", ownerUser.id, Date.now());
  run('INSERT INTO members(conv_id, user_id) VALUES(?,?), (?,?)', id, ownerUser.id, id, b);
  return Number(id);
}
const botSay = async (text, extra = null) => {
  const o = owner(); if (!o) return null;
  return postMessage(botConv(o), botId(), { kind: extra ? 'card' : 'text', text, extra });
};

function openDm(a, b) {
  const row = one(`SELECT c.id FROM convs c WHERE c.kind = 'dm'
    AND EXISTS (SELECT 1 FROM members WHERE conv_id = c.id AND user_id = ?) AND EXISTS (SELECT 1 FROM members WHERE conv_id = c.id AND user_id = ?)`, a, b);
  if (row) return row.id;
  const { lastInsertRowid: id } = run("INSERT INTO convs(kind, created_by, created) VALUES('dm', ?, ?)", a, Date.now());
  run('INSERT INTO members(conv_id, user_id) VALUES(?,?), (?,?)', id, a, id, b);
  return Number(id);
}

// Streams a voice note with Range support (iOS Safari needs it to play audio).
function sendMedia(req, res, file, type) {
  const size = statSync(file).size;
  const r = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  let start = 0, end = size - 1;
  if (r) {
    start = r[1] ? Number(r[1]) : Math.max(0, size - Number(r[2]));
    end = r[1] && r[2] ? Math.min(Number(r[2]), size - 1) : size - 1;
    if (start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
  }
  res.writeHead(r ? 206 : 200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1,
    'Cache-Control': 'private, max-age=31536000, immutable', ...(r && { 'Content-Range': `bytes ${start}-${end}/${size}` }) });
  createReadStream(file, { start, end }).pipe(res);
}
const AUDIO = { 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/mpeg': 'mp3', 'audio/webm': 'webm', 'audio/ogg': 'ogg' };

// ---------- routes ----------
const sendRate = new Map();   // userId -> [timestamps]
function rateOk(userId) {
  const r = (sendRate.get(userId) || []).filter((t) => Date.now() - t < 60e3);
  r.push(Date.now()); sendRate.set(userId, r);
  return r.length <= 40;
}

async function api(req, res, path, query) {
  const M = req.method;
  // CSRF: state-changing calls must carry a header a cross-site form cannot set.
  if (M !== 'GET' && req.headers['x-cup'] !== '1') throw err(403, 'Forbidden');

  // ----- public: sign in, invites -----
  if (M === 'POST' && path === '/api/login') {
    const ip = visitorIp(req);
    if (locked(ip)) throw err(429, 'Too many attempts. Try again in 15 minutes.');
    const b = await readJson(req, 2000);
    const u = one('SELECT * FROM users WHERE username = ? AND active = 1', String(b.username || '').trim().toLowerCase());
    if (!u || u.role === 'bot' || !checkPw(u, b.password)) { fail(ip); log(`login failed from ${ip}`); throw err(401, 'Wrong username or password.'); }
    return send(res, 200, { user: publicUser(u) }, { 'Set-Cookie': cookie(newSession(u.id), SESSION_DAYS * 86400) });
  }
  let m;
  if ((m = /^\/api\/invite\/([a-f0-9]{32})$/.exec(path))) {
    const inv = one('SELECT i.*, u.name AS by FROM invites i LEFT JOIN users u ON u.id = i.created_by WHERE i.token = ? AND i.used_by IS NULL AND i.expires > ?', m[1], Date.now());
    if (M === 'GET') return send(res, 200, inv ? { valid: true, by: inv.by || 'Guman', owner: inv.role === 'owner' } : { valid: false });
    if (!inv) throw err(410, 'This invite has expired or was already used.');
    const ip = visitorIp(req);
    if (locked(ip)) throw err(429, 'Too many attempts. Try again in 15 minutes.');
    const s = validSignup(await readJson(req, 2000));
    const salt = randomBytes(16).toString('hex');
    const role = inv.role === 'owner' && !owner() ? 'owner' : 'friend';
    const { lastInsertRowid: uid } = run('INSERT INTO users(username, name, salt, hash, role, created) VALUES(?,?,?,?,?,?)',
      s.username, s.name, salt, hashPw(s.password, salt), role, Date.now());
    run('UPDATE invites SET used_by = ? WHERE token = ?', uid, inv.token);
    const u = one('SELECT * FROM users WHERE id = ?', uid);
    log(`new ${role}: ${u.username}`);
    if (role === 'owner') { botConv(u); await botSay('Hi Guman 👋 I\'m your S20. I\'ll message you here when I need something. Type "help" to see what I can do.'); }
    else {
      const o = owner();
      if (o) { const dm = openDm(o.id, u.id); await postMessage(dm, u.id, { text: `👋 ${u.name} joined Cupboard` }); }
    }
    return send(res, 200, { user: publicUser(u) }, { 'Set-Cookie': cookie(newSession(u.id), SESSION_DAYS * 86400) });
  }

  // ----- signed in -----
  const me = userOf(req);
  if (path === '/api/me' && M === 'GET') return send(res, 200, { user: publicUser(me), vapid: push.publicKey, push: me ? push.hasPush(me.id) : false });
  if (!me) throw err(401, 'Sign in first.');
  if (M === 'POST' && path === '/api/logout') { run('DELETE FROM sessions WHERE token = ?', me.token); return send(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) }); }

  if (M === 'GET' && path === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    if (!streams.has(me.id)) streams.set(me.id, new Set());
    const set = streams.get(me.id);
    if (set.size >= 6) { const oldest = set.values().next().value; oldest.end(); set.delete(oldest); }
    set.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20e3);
    req.on('close', () => { clearInterval(ping); set.delete(res); });
    return;
  }
  if (M === 'POST' && path === '/api/presence') {
    const b = await readJson(req, 200);
    if (b.visible) activeUntil.set(me.id, Date.now() + 45e3); else activeUntil.delete(me.id);
    return send(res, 200, { ok: true });
  }
  if (M === 'POST' && path === '/api/push') { push.subscribe(me.id, (await readJson(req, 4000)).subscription); return send(res, 200, { ok: true }); }
  if (M === 'DELETE' && path === '/api/push') { push.unsubscribe(me.id, (await readJson(req, 4000)).endpoint); return send(res, 200, { ok: true }); }

  if (M === 'GET' && path === '/api/status') {
    const { readFileSync } = await import('node:fs');
    try {
      const s = JSON.parse(readFileSync(join(process.env.HOME, 'live', 'status.json'), 'utf8'));
      return send(res, 200, { battery: s.battery, tempC: s.cpuTempC, upSince: s.upSince * 1000 });
    } catch { return send(res, 200, {}); }
  }

  if (M === 'GET' && path === '/api/users') {
    return send(res, 200, { users: all("SELECT id, username, name, role FROM users WHERE active = 1 AND role != 'bot' AND id != ? ORDER BY name", me.id) });
  }
  if ((m = /^\/api\/users\/(\d+)$/.exec(path)) && M === 'DELETE') {
    if (me.role !== 'owner') throw err(403, 'Only the owner can remove people.');
    const id = Number(m[1]);
    if (id === me.id || one('SELECT role FROM users WHERE id = ?', id)?.role === 'bot') throw err(400, 'Not allowed.');
    run('UPDATE users SET active = 0 WHERE id = ?', id);
    run('DELETE FROM sessions WHERE user_id = ?', id);
    run('DELETE FROM push_subs WHERE user_id = ?', id);
    for (const res2 of streams.get(id) || []) res2.end();
    return send(res, 200, { ok: true });
  }
  if (M === 'POST' && path === '/api/invites') {
    if (me.role !== 'owner') throw err(403, 'Only the owner can invite.');
    const token = randomBytes(16).toString('hex');
    run('INSERT INTO invites(token, created_by, expires) VALUES(?,?,?)', token, me.id, Date.now() + 7 * 86400e3);
    return send(res, 200, { path: `/invite/${token}`, expires: Date.now() + 7 * 86400e3 });
  }

  if (M === 'GET' && path === '/api/convs') {
    const ids = all('SELECT conv_id FROM members WHERE user_id = ?', me.id).map((r) => r.conv_id);
    const convs = ids.map((id) => convSummary(id, me)).sort((a, b) => (b.last?.at || b.created) - (a.last?.at || a.created));
    return send(res, 200, { convs });
  }
  if (M === 'POST' && path === '/api/convs') {
    const b = await readJson(req, 4000);
    const ids = [...new Set((b.members || []).map(Number))].filter((id) => id !== me.id);
    const valid = ids.filter((id) => one("SELECT 1 FROM users WHERE id = ? AND active = 1 AND role != 'bot'", id));
    if (!valid.length) throw err(400, 'Pick at least one person.');
    if (valid.length === 1 && !b.name) return send(res, 200, { conv: convSummary(openDm(me.id, valid[0]), me) });
    const name = String(b.name || '').trim().slice(0, 40);
    if (!name) throw err(400, 'Give the group a name.');
    const { lastInsertRowid: id } = run("INSERT INTO convs(kind, name, created_by, created) VALUES('group', ?, ?, ?)", name, me.id, Date.now());
    for (const uid of [me.id, ...valid]) run('INSERT INTO members(conv_id, user_id) VALUES(?,?)', id, uid);
    await postMessage(Number(id), me.id, { text: `${me.name} created "${name}"` });
    return send(res, 200, { conv: convSummary(Number(id), me) });
  }

  if ((m = /^\/api\/convs\/(\d+)(\/[a-z]+)?$/.exec(path))) {
    const convId = Number(m[1]), sub = m[2] || '';
    if (!canSee(me, convId)) throw err(404, 'Not found.');
    const conv = one('SELECT * FROM convs WHERE id = ?', convId);
    if (M === 'GET' && sub === '') return send(res, 200, { conv: convSummary(convId, me) });
    if (M === 'GET' && sub === '/messages') {
      const before = Number(query.before) || Number.MAX_SAFE_INTEGER;
      const rows = all('SELECT * FROM messages WHERE conv_id = ? AND id < ? ORDER BY id DESC LIMIT 60', convId, before).reverse();
      return send(res, 200, { messages: rows.map(rowToMsg), more: rows.length === 60 });
    }
    if (M === 'POST' && sub === '/messages') {
      if (!rateOk(me.id)) throw err(429, 'Slow down a little.');
      const b = await readJson(req, 20_000);
      const text = String(b.text || '').trim().slice(0, 4000);
      if (!text) throw err(400, 'Empty message.');
      const msg = await postMessage(convId, me.id, { text, extra: b.replyTo ? { replyTo: Number(b.replyTo) } : null });
      if (conv.kind === 'bot') setImmediate(() => botReply({ text, replyTo: b.replyTo ? one('SELECT * FROM messages WHERE id = ? AND conv_id = ?', Number(b.replyTo), convId) : null, say: botSay, update: updateMessage }).catch((e) => log('bot', e.message)));
      return send(res, 200, { msg });
    }
    if (M === 'POST' && sub === '/voice') {
      if (!rateOk(me.id)) throw err(429, 'Slow down a little.');
      const type = String(req.headers['content-type'] || '').split(';')[0].trim();
      if (!AUDIO[type]) throw err(415, 'Unsupported audio format.');
      const duration = Math.min(180, Math.max(0.5, Number(req.headers['x-duration']) || 0));
      const peaks = String(req.headers['x-peaks'] || '').split(',').slice(0, 40).map((x) => Math.max(0, Math.min(9, Number(x) || 0)));
      const buf = await readRaw(req, 3 * 1024 * 1024);
      if (buf.length < 500) throw err(400, 'Recording too short.');
      const file = `${randomBytes(12).toString('hex')}.${AUDIO[type]}`;
      writeFileSync(join(MEDIA, file), buf, { mode: 0o600 });
      const msg = await postMessage(convId, me.id, { kind: 'voice', media: `${file}|${type}`, duration, extra: { peaks } });
      return send(res, 200, { msg });
    }
    if (M === 'POST' && sub === '/read') {
      const b = await readJson(req, 200);
      const upTo = Math.min(Number(b.upTo) || 0, one('SELECT coalesce(max(id), 0) AS n FROM messages WHERE conv_id = ?', convId).n);
      run('UPDATE members SET last_read = max(last_read, ?) WHERE conv_id = ? AND user_id = ?', upTo, convId, me.id);
      for (const uid of memberIds(convId)) emit(uid, 'read', { conv: convId, user: me.id, upTo });
      return send(res, 200, { ok: true });
    }
    if (M === 'POST' && sub === '/typing') {
      for (const uid of memberIds(convId)) if (uid !== me.id) emit(uid, 'typing', { conv: convId, user: me.id, name: me.name });
      return send(res, 200, { ok: true });
    }
  }

  if ((m = /^\/api\/messages\/(\d+)\/action$/.exec(path)) && M === 'POST') {
    const row = one('SELECT * FROM messages WHERE id = ?', Number(m[1]));
    if (!row || !canSee(me, row.conv_id) || one('SELECT kind FROM convs WHERE id = ?', row.conv_id).kind !== 'bot') throw err(404, 'Not found.');
    const b = await readJson(req, 1000);
    const msg = await botAction({ row, action: String(b.action || ''), say: botSay, update: updateMessage });
    return send(res, 200, { msg });
  }

  if ((m = /^\/api\/media\/(\d+)$/.exec(path)) && M === 'GET') {
    const row = one('SELECT * FROM messages WHERE id = ?', Number(m[1]));
    if (!row?.media || !canSee(me, row.conv_id)) throw err(404, 'Not found.');
    const [file, type] = row.media.split('|');
    const full = join(MEDIA, file);
    if (!existsSync(full)) throw err(404, 'Not found.');
    return sendMedia(req, res, full, type);
  }

  throw err(404, 'Not found.');
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname.replace(/^\/cupboard/, '');
  try { await api(req, res, path, Object.fromEntries(url.searchParams)); }
  catch (e) {
    if (!e.expose) log(`${req.method} ${path}: ${e.stack || e.message}`);
    if (!res.headersSent) send(res, e.status || 500, { error: e.expose ? e.message : 'Something went wrong.' });
  }
}).listen(PORT, '127.0.0.1', () => log(`cupboard on 127.0.0.1:${PORT}`));

// ---------- internal: services on this phone message the owner through the S20 bot ----------
// POST /notify {title?, text, actions?: [{id, label, style?}], ref?, replyTo?}
//   replyTo: a local URL (http://127.0.0.1:<port>/...) that receives {text|action, ref} when the owner answers.
//   Reply: {id, pushable}; pushable=false means the owner has no device with notifications yet (keep a fallback).
createServer(async (req, res) => {
  try {
    if (req.method !== 'POST' || req.headers['x-visitor-ip']) return send(res, 404, { error: 'Not found' });
    const b = await readJson(req, 20_000);
    const o = owner();
    if (!o) return send(res, 503, { error: 'No owner yet', pushable: false });
    if (req.url === '/notify') {
      const text = String(b.text || '').slice(0, 4000);
      if (!text) return send(res, 400, { error: 'text required' });
      const replyTo = /^http:\/\/127\.0\.0\.1:\d+\//.test(b.replyTo || '') ? b.replyTo : null;
      const actions = Array.isArray(b.actions) ? b.actions.slice(0, 6).map((a) => ({ id: String(a.id).slice(0, 40), label: String(a.label).slice(0, 30), value: String(a.value ?? a.label).slice(0, 300), style: a.style === 'go' ? 'go' : '' })) : [];
      const extra = { title: String(b.title || '').slice(0, 40) || null, actions, ref: b.ref ?? null, replyTo };
      const msg = await botSay(text, extra);
      return send(res, 200, { id: msg.id, pushable: push.hasPush(o.id) });
    }
    if (req.url === '/update') {
      const row = one('SELECT * FROM messages WHERE id = ?', Number(b.id));
      if (!row) return send(res, 404, { error: 'Not found' });
      return send(res, 200, { msg: updateMessage(row.id, { done: String(b.done || '').slice(0, 60) || null }) });
    }
    return send(res, 404, { error: 'Not found' });
  } catch (e) { send(res, e.status || 500, { error: e.message }); }
}).listen(INTERNAL, '127.0.0.1', () => log(`cupboard internal on 127.0.0.1:${INTERNAL}`));

// Keep the database tidy: expired invites and sessions.
setInterval(() => { run('DELETE FROM sessions WHERE expires < ?', Date.now()); run('DELETE FROM invites WHERE used_by IS NULL AND expires < ?', Date.now()); }, 6 * 3600e3);
export { db };
