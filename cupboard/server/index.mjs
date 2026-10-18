// Cupboard: a small WhatsApp-style chat served from the phone. Two listeners, both on localhost only:
//   127.0.0.1:8085  the app's API (nginx proxies /cupboard/api/* here, reached via the "cupboard" Worker)
//   127.0.0.1:8086  internal: other services on the phone (job agent, room watcher, expenses) message the
//                   owner through the "S20" bot. nginx never proxies this port.
// All text is stored and sent as plain text; the web app inserts it as text, never as HTML.
import { createServer } from 'node:http';
import { scryptSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { writeFileSync, statSync, createReadStream, existsSync, unlinkSync, realpathSync, readFileSync as readFileSyncFs } from 'node:fs';
import { join } from 'node:path';
import { db, one, all, run, MEDIA, botId, owner, getKv, setKv } from './db.mjs';
import * as push from './push.mjs';
import { botReply, botAction } from './bot.mjs';
import { install as installTogether } from './together.mjs';
import { install as installWedding } from './wedding.mjs';
import { install as installAssistant } from './assistant.mjs';
import { install as installLove } from './lovenotes.mjs';
import { install as installCalls } from './calls.mjs';

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
  return one('SELECT u.*, s.token, s.expires FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires > ? AND u.active = 1', m[1], Date.now()) || null;
}
const publicUser = (u) => u && ({ id: u.id, username: u.username, name: u.name, role: u.role });

// ---------- trusted devices ----------
// A browser reaches Cupboard only once it is trusted: through a one-time "add a device" link made on a trusted device
// (or by the owner's add-device.sh), or an invite link. Unknown browsers get 404 for everything, so there is no login
// form to guess at. Browsers already signed in when this started were trusted automatically on their next visit.
const DEVICE_YEARS = 2;
if (!getKv('devices_since')) setKv('devices_since', Date.now());
const sha = (t) => createHash('sha256').update(t).digest('hex');
const devCookie = (token) => `cbd=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${token ? DEVICE_YEARS * 365 * 86400 : 0}`;
function deviceOf(req) {
  const m = /(?:^|;\s*)cbd=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  const d = m && one('SELECT * FROM devices WHERE hash = ?', sha(m[1]));
  if (d && Date.now() - (d.seen || 0) > 3600e3) run('UPDATE devices SET seen = ? WHERE id = ?', Date.now(), d.id);
  return d || null;
}
function deviceName(req) {
  const ua = String(req.headers['user-agent'] || '');
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? (/; ([^;)]+?) Build/.exec(ua)?.[1] || 'Android') : /Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows PC' : /Linux/.test(ua) ? 'Linux' : 'Browser';
  const br = /Edg\//.test(ua) ? 'Edge' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  return `${os}${br ? ` · ${br}` : ''}`.slice(0, 60);
}
function trustDevice(req, userId, addedBy) {          // returns the Set-Cookie value for the new device
  const token = randomBytes(32).toString('hex');
  run('INSERT INTO devices(hash, name, user_id, added_by, created, seen) VALUES(?,?,?,?,?,?)', sha(token), deviceName(req), userId, addedBy, Date.now(), Date.now());
  log(`device trusted: ${deviceName(req)} (user ${userId ?? '-'})`);
  return devCookie(token);
}
function deviceLink(createdBy) {
  const token = randomBytes(16).toString('hex');
  setKv(`devlink:${token}`, JSON.stringify({ by: createdBy, exp: Date.now() + 15 * 60e3 }));
  return `/device/${token}`;
}
// A session that existed before devices were required (sessions last SESSION_DAYS from sign-in).
const signedInBefore = (u) => u && u.expires - SESSION_DAYS * 86400e3 < Number(getKv('devices_since'));

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
  const title = c.kind === 'group' || (c.kind === 'bot' && c.name === NCR_CHAT) ? c.name : other?.name || 'Chat';
  const set = one('SELECT muted_until, archived FROM members WHERE conv_id = ? AND user_id = ?', convId, forUser.id) || {};
  const pins = all('SELECT m.* FROM pins p JOIN messages m ON m.id = p.msg_id WHERE p.conv_id = ? ORDER BY p.at DESC LIMIT 10', convId).map(rowToMsg);
  return { id: c.id, kind: c.kind, title, people: people.map(({ last_read, ...p }) => ({ ...p, lastRead: last_read })),
    last: last ? rowToMsg(last) : null, unread, created: c.created,
    muted: set.muted_until > Date.now() ? set.muted_until : 0, archived: !!set.archived, pins,
    ...(assistant.isAssistant(convId) ? { assistant: { quiet: assistant.quiet() } } : {}) };
}
// Tell every member that a chat's settings or pins changed (each gets their own view of it).
function emitConv(convId) {
  for (const uid of memberIds(convId)) { const u = one('SELECT * FROM users WHERE id = ?', uid); if (u.role !== 'bot') emit(uid, 'conv', { conv: convSummary(convId, u) }); }
}
const PUSH_LABEL = { voice: '🎤 Voice note', image: '📷 Photo', video: '🎥 Video', file: '📄 File' };

/** Save a message and fan it out: live update to every member, push to members who are not looking.
 *  force: push even to muted chats and open apps (reminders); pushAs: {title, body} instead of the sender's name;
 *  pushOnly: push only to these user ids (the others still see it live). */
async function postMessage(convId, fromId, { kind = 'text', text = null, media = null, duration = null, extra = null }, { force = false, pushAs = null, pushOnly = null } = {}) {
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
    const muted = (one('SELECT muted_until FROM members WHERE conv_id = ? AND user_id = ?', convId, uid)?.muted_until || 0) > now;
    if (uid !== fromId && (!pushOnly || pushOnly.includes(uid)) && (force || (!isActive(uid) && !muted))) {
      if (pushAs) { push.notify(uid, { title: pushAs.title.slice(0, 80), body: String(pushAs.body || '').slice(0, 180), url: `/c/${convId}`, tag: `r${id}` }); continue; }
      const label = PUSH_LABEL[kind] ? `${PUSH_LABEL[kind]}${kind === 'file' && extra?.name ? ` · ${extra.name}` : ''}${text ? `: ${text}` : ''}` : null;
      const body = label || (extra?.title ? `${extra.title}: ` : '') + (text || '');
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

// Every person has their own private bot conversation (the owner's is "S20"; a friend's is their job agent).
function botConv(user) {
  const b = botId();
  const row = one("SELECT c.id FROM convs c JOIN members m ON m.conv_id = c.id WHERE c.kind = 'bot' AND m.user_id = ? AND COALESCE(c.name, '') != ?", user.id, NCR_CHAT);
  if (row) return row.id;
  const { lastInsertRowid: id } = run("INSERT INTO convs(kind, name, created_by, created) VALUES('bot', ?, ?, ?)", user.role === 'owner' ? 'S20' : 'Job agent', user.id, Date.now());
  run('INSERT INTO members(conv_id, user_id) VALUES(?,?), (?,?)', id, user.id, id, b);
  return Number(id);
}
// A second bot chat per person for the job agent's Delhi NCR jobs (cards, screenshots, fill-and-submit), apart from "Job agent".
const NCR_CHAT = '📍 Delhi NCR jobs';
function ncrConv(user) {
  const row = one("SELECT c.id FROM convs c JOIN members m ON m.conv_id = c.id WHERE c.kind = 'bot' AND c.name = ? AND m.user_id = ?", NCR_CHAT, user.id);
  if (row) return row.id;
  const { lastInsertRowid: id } = run("INSERT INTO convs(kind, name, created_by, created) VALUES('bot', ?, ?, ?)", NCR_CHAT, user.id, Date.now());
  run('INSERT INTO members(conv_id, user_id) VALUES(?,?), (?,?)', id, user.id, id, botId());
  return Number(id);
}
const isNcrConv = (conv) => conv?.kind === 'bot' && conv.name === NCR_CHAT;
// Screenshots a local job agent sends with a message: only its own shots folders, copied into Cupboard media.
const SHOTS = /^\/home\/gpsingh\/jobagent\/(people\/[a-z0-9_-]+\/)?data\/shots\/[\w.-]+\.png$/;
function shotToMedia(path) {
  let real;
  try { real = realpathSync(String(path)); } catch { return null; }
  if (!SHOTS.test(real)) return null;
  const buf = readFileSyncFs(real);
  if (buf.length < 16 || buf.length > 15 * 1048576) return null;
  const file = `${randomBytes(12).toString('hex')}.png`;
  writeFileSync(join(MEDIA, file), buf, { mode: 0o600 });
  return { media: `${file}|image/png`, size: buf.length, w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}
const botSay = async (text, extra = null, user = owner()) => {
  if (!user) return null;
  return postMessage(botConv(user), botId(), { kind: extra ? 'card' : 'text', text, extra });
};
// The local job agent that serves a given person (set when that agent first messages them). Owner: the main agent.
const agentFor = (user) => (user.role === 'owner' ? 'http://127.0.0.1:8083' : getKv(`agent:${user.id}`));
const FILES = { 'application/pdf': 'pdf' };
// Shared lists, calendar and reminders (together.mjs).
const together = installTogether({ postMessage, updateMessage, emit, memberIds, canSee, readJson, send, err, log, botConv,
  convTitle: (id, me) => convSummary(id, me).title });
const wedding = installWedding({ emit, memberIds, canSee, readJson, send, err, postMessage, together });
const assistant = installAssistant({ postMessage, emit, memberIds, together, log });
const love = installLove({ postMessage, updateMessage, log, botConv });
const calls = installCalls({ emit, canSee, readJson, send, err, postMessage, notify: (uid, p) => push.notify(uid, p), isActive, log });

function openDm(a, b) {
  const row = one(`SELECT c.id FROM convs c WHERE c.kind = 'dm'
    AND EXISTS (SELECT 1 FROM members WHERE conv_id = c.id AND user_id = ?) AND EXISTS (SELECT 1 FROM members WHERE conv_id = c.id AND user_id = ?)`, a, b);
  if (row) return row.id;
  const { lastInsertRowid: id } = run("INSERT INTO convs(kind, created_by, created) VALUES('dm', ?, ?)", a, Date.now());
  run('INSERT INTO members(conv_id, user_id) VALUES(?,?), (?,?)', id, a, id, b);
  return Number(id);
}

// Streams a voice note with Range support (iOS Safari needs it to play audio).
function sendMedia(req, res, file, type, downloadName) {
  const size = statSync(file).size;
  const r = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  let start = 0, end = size - 1;
  if (r) {
    start = r[1] ? Number(r[1]) : Math.max(0, size - Number(r[2]));
    end = r[1] && r[2] ? Math.min(Number(r[2]), size - 1) : size - 1;
    if (start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
  }
  // Documents always download (never rendered as a page from our origin); photos, videos and audio show inline.
  const inline = /^(image|video|audio)\//.test(type);
  res.writeHead(r ? 206 : 200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=31536000, immutable', ...(r && { 'Content-Range': `bytes ${start}-${end}/${size}` }),
    ...(!inline && { 'Content-Disposition': `attachment; filename="${String(downloadName || 'file').replace(/[^\w .()-]/g, '_')}"` }) });
  createReadStream(file, { start, end }).pipe(res);
}
// What can be shared in chats (an allow-list: no HTML, SVG or scripts, which would run from our own origin).
const IMAGES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const VIDEOS = { 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm' };
const DOCS = { 'application/pdf': 'pdf', 'text/plain': 'txt', 'text/csv': 'csv', 'application/zip': 'zip',
  'application/msword': 'doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt', 'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx' };
const LIMIT_MB = { image: 15, video: 60, file: 25 };
const REACTIONS = ['❤️', '👍', '😂', '😮', '😢', '🙏'];
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

  // ----- an unknown browser: only the add-device and invite links work -----
  const device = deviceOf(req);
  if (!device) {
    const dm = /^\/api\/device\/([a-f0-9]{32})$/.exec(path);
    if (dm) {
      const link = JSON.parse(getKv(`devlink:${dm[1]}`) || 'null');
      if (!link || link.exp < Date.now()) throw err(410, 'This add-device link has expired or was already used. Make a new one on a device that already uses Cupboard.');
      if (M === 'GET') return send(res, 200, { valid: true });
      run('DELETE FROM kv WHERE k = ?', `devlink:${dm[1]}`);
      return send(res, 200, { ok: true }, { 'Set-Cookie': trustDevice(req, null, link.by) });
    }
    if (path === '/api/me' && M === 'GET') {
      const u = userOf(req);
      if (signedInBefore(u)) {                            // already signed in before devices were required: trusted as it is
        return send(res, 200, { user: publicUser(u), vapid: push.publicKey, push: push.hasPush(u.id), device: true }, { 'Set-Cookie': trustDevice(req, u.id, null) });
      }
      return send(res, 200, { user: null, device: false });
    }
    if (!/^\/api\/invite\/[a-f0-9]{32}$/.test(path)) throw err(404, 'Not found.');
  }

  // ----- sign in (trusted devices only), invites -----
  if (M === 'POST' && path === '/api/login') {
    const ip = visitorIp(req);
    if (locked(ip)) throw err(429, 'Too many attempts. Try again in 15 minutes.');
    const b = await readJson(req, 2000);
    const u = one('SELECT * FROM users WHERE username = ? AND active = 1', String(b.username || '').trim().toLowerCase());
    if (!u || u.role === 'bot' || !checkPw(u, b.password)) { fail(ip); log(`login failed from ${ip}`); throw err(401, 'Wrong username or password.'); }
    run('UPDATE devices SET user_id = ? WHERE id = ?', u.id, device.id);
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
    // The invite link also trusts the browser it was opened in.
    return send(res, 200, { user: publicUser(u) }, { 'Set-Cookie': [cookie(newSession(u.id), SESSION_DAYS * 86400), ...(device ? [] : [trustDevice(req, u.id, inv.created_by)])] });
  }

  // ----- signed in -----
  const me = userOf(req);
  if (path === '/api/me' && M === 'GET') return send(res, 200, { user: publicUser(me), vapid: push.publicKey, push: me ? push.hasPush(me.id) : false, device: true });
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
  // ----- trusted devices: list (mine, and ones I added), add one through a link, remove one -----
  if (M === 'GET' && path === '/api/devices') {
    const rows = me.role === 'owner' ? all('SELECT d.*, u.name AS uname FROM devices d LEFT JOIN users u ON u.id = d.user_id ORDER BY d.seen DESC')
      : all('SELECT d.*, u.name AS uname FROM devices d LEFT JOIN users u ON u.id = d.user_id WHERE d.user_id = ? OR d.added_by = ? ORDER BY d.seen DESC', me.id, me.id);
    return send(res, 200, { devices: rows.map((d) => ({ id: d.id, name: d.name, who: d.uname, created: d.created, seen: d.seen, current: d.id === device.id })) });
  }
  if (M === 'POST' && path === '/api/devices/link') return send(res, 200, { path: deviceLink(me.id), expires: Date.now() + 15 * 60e3 });
  if ((m = /^\/api\/devices\/(\d+)$/.exec(path)) && M === 'DELETE') {
    const d = one('SELECT * FROM devices WHERE id = ?', Number(m[1]));
    if (!d || (me.role !== 'owner' && d.user_id !== me.id && d.added_by !== me.id)) throw err(404, 'Not found.');
    run('DELETE FROM devices WHERE id = ?', d.id);
    log(`device removed: ${d.name} by ${me.username}`);
    return send(res, 200, { ok: true }, d.id === device.id ? { 'Set-Cookie': devCookie('') } : {});
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
    if (M === 'GET' && sub === '/messages' && query.around) {          // a search result or pinned message: the messages around it
      const at = Number(query.around);
      const older = all('SELECT * FROM messages WHERE conv_id = ? AND id <= ? ORDER BY id DESC LIMIT 40', convId, at).reverse();
      const newer = all('SELECT * FROM messages WHERE conv_id = ? AND id > ? ORDER BY id LIMIT 40', convId, at);
      return send(res, 200, { messages: [...older, ...newer].map(rowToMsg), more: older.length === 40, newer: newer.length === 40 });
    }
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
      love.onMessage(me, convId, text);
      if (assistant.isAssistant(convId)) { if (assistant.shouldReply(text)) setImmediate(() => assistant.reply(me, convId).catch((e) => log('assistant', e.message))); }
      else if (together.isRemind(text)) setImmediate(() => together.fromChat(me, conv, text).catch((e) => log('remind', e.message)));
      else if (assistant.isCoach(convId) && assistant.coachWants(text)) setImmediate(() => assistant.reply(me, convId).catch((e) => log('assistant', e.message)));
      else if (isNcrConv(conv)) setImmediate(async () => {
        const agent = getKv(`ncragent:${me.id}`) || agentFor(me);
        try {
          const r = await fetch(`${agent}/internal/ncr`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20000),
            body: JSON.stringify({ text, msgId: msg.id }) });
          if (!r.ok) throw new Error(`${r.status}`);
        } catch (e) { postMessage(convId, botId(), { kind: 'text', text: `Couldn't reach your job agent (${e.message}). Try again in a minute.` }); }
      });
      else if (conv.kind === 'bot') setImmediate(async () => {
        try {
          // Guman's own commands for the notes to her ("love: …") come first; everything else goes to the bot as before.
          const lr = me.role === 'owner' ? await (love.command(text).then((r) => r ?? calls.command(text))).catch((e) => `Could not do that: ${e.message}`) : null;
          if (lr) return await botSay(lr, null, me);
          await botReply({ text, msgId: msg.id, user: me, agent: agentFor(me), replyTo: b.replyTo ? one('SELECT * FROM messages WHERE id = ? AND conv_id = ?', Number(b.replyTo), convId) : null, say: (t, e) => botSay(t, e, me), update: updateMessage });
        } catch (e) { log('bot', e.message); }
      });
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
    // A document (PDF resume) in the person's own bot chat: stored like a voice note and handed to their job agent.
    if (M === 'POST' && sub === '/file') {
      if (!rateOk(me.id)) throw err(429, 'Slow down a little.');
      if (conv.kind !== 'bot') throw err(400, 'Files can only be sent to your bot for now.');
      const type = String(req.headers['content-type'] || '').split(';')[0].trim();
      if (!FILES[type]) throw err(415, 'Please attach a PDF.');
      const buf = await readRaw(req, 4 * 1024 * 1024);
      if (buf.length < 500 || buf.subarray(0, 5).toString() !== '%PDF-') throw err(400, 'That does not look like a PDF.');
      const name = (() => { try { return decodeURIComponent(String(req.headers['x-filename'] || '')); } catch { return ''; } })().replace(/[^\w .()-]/g, '').slice(0, 80) || 'document.pdf';
      const file = `${randomBytes(12).toString('hex')}.${FILES[type]}`;
      writeFileSync(join(MEDIA, file), buf, { mode: 0o600 });
      const msg = await postMessage(convId, me.id, { kind: 'file', media: `${file}|${type}`, extra: { name, size: buf.length } });
      const agent = agentFor(me);
      setImmediate(async () => {
        if (!agent) return botSay('Got it, but no job agent is set up for you yet.', null, me);
        try {
          const r = await fetch(`${agent}/internal/cupboard`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20000),
            body: JSON.stringify({ file: join(MEDIA, file), name, ref: { ref_kind: 'file' } }) });
          if (!r.ok) throw new Error(`${r.status}`);
        } catch (e) { botSay(`Couldn't hand that file to your job agent (${e.message}). Try again in a minute.`, null, me); }
      });
      return send(res, 200, { msg });
    }
    // Photos, videos and documents in person-to-person chats and groups (the bot chat keeps /file for the job agent).
    if (M === 'POST' && sub === '/upload') {
      if (conv.kind === 'bot') throw err(400, 'Send files to your bot with the 📎 button.');
      if (!rateOk(me.id)) throw err(429, 'Slow down a little.');
      const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      const kind = IMAGES[type] ? 'image' : VIDEOS[type] ? 'video' : DOCS[type] ? 'file' : null;
      if (!kind) throw err(415, 'That kind of file can\'t be shared here (photos, videos, PDF, Office, text, CSV or ZIP).');
      if (Number(req.headers['content-length']) > LIMIT_MB[kind] * 1048576) throw err(413, `Too large: up to ${LIMIT_MB[kind]} MB for a ${kind === 'file' ? 'document' : kind}.`);
      const buf = await readRaw(req, LIMIT_MB[kind] * 1048576);
      if (buf.length < 16) throw err(400, 'That file is empty.');
      const dec = (h) => { try { return decodeURIComponent(String(req.headers[h] || '')); } catch { return ''; } };
      const name = dec('x-filename').replace(/[^\w .()-]/g, '').slice(0, 80) || `${kind}.${(IMAGES[type] || VIDEOS[type] || DOCS[type])}`;
      const caption = dec('x-caption').trim().slice(0, 1000) || null;
      const dim = (h) => Math.max(0, Math.min(20000, Number(req.headers[h]) || 0)) || undefined;
      const file = `${randomBytes(12).toString('hex')}.${IMAGES[type] || VIDEOS[type] || DOCS[type]}`;
      writeFileSync(join(MEDIA, file), buf, { mode: 0o600 });
      const msg = await postMessage(convId, me.id, { kind, text: caption, media: `${file}|${type}`,
        extra: { name, size: buf.length, w: dim('x-width'), h: dim('x-height'), ...(Number(query.replyTo) ? { replyTo: Number(query.replyTo) } : {}) } });
      if (kind === 'image') assistant.onImage(me, convId, caption);
      return send(res, 200, { msg });
    }
    if (M === 'GET' && sub === '/media') {                  // the chat's gallery: photos and videos, and documents
      const rows = all("SELECT * FROM messages WHERE conv_id = ? AND kind IN ('image','video','file') AND media IS NOT NULL ORDER BY id DESC LIMIT 300", convId);
      return send(res, 200, { media: rows.map(rowToMsg) });
    }
    if (M === 'POST' && sub === '/settings') {              // mute (hours, or -1 for always; 0 = unmute) and archive, for me only
      const b = await readJson(req, 200);
      if (b.mute !== undefined) {
        const hours = Number(b.mute);
        const until = hours === -1 ? 8.64e15 : hours > 0 ? Date.now() + Math.min(hours, 24 * 365) * 3600e3 : 0;
        run('UPDATE members SET muted_until = ? WHERE conv_id = ? AND user_id = ?', until, convId, me.id);
      }
      if (b.archived !== undefined) run('UPDATE members SET archived = ? WHERE conv_id = ? AND user_id = ?', b.archived ? 1 : 0, convId, me.id);
      const c = convSummary(convId, me);
      emit(me.id, 'conv', { conv: c });
      return send(res, 200, { conv: c });
    }
    if (M === 'POST' && sub === '/read') {
      const b = await readJson(req, 200);
      const upTo = Math.min(Number(b.upTo) || 0, one('SELECT coalesce(max(id), 0) AS n FROM messages WHERE conv_id = ?', convId).n);
      run('UPDATE members SET last_read = max(last_read, ?) WHERE conv_id = ? AND user_id = ?', upTo, convId, me.id);
      for (const uid of memberIds(convId)) emit(uid, 'read', { conv: convId, user: me.id, upTo });
      love.onRead(me, convId, upTo);
      return send(res, 200, { ok: true });
    }
    if (M === 'POST' && sub === '/assistant') {            // the 🤫 button: quiet / wake the assistant (for everyone in the chat)
      if (!assistant.isAssistant(convId)) throw err(404, 'Not found.');
      await assistant.setQuiet(me, convId, !!(await readJson(req, 200)).quiet);
      emitConv(convId);
      return send(res, 200, { conv: convSummary(convId, me) });
    }
    if (M === 'POST' && sub === '/typing') {
      for (const uid of memberIds(convId)) if (uid !== me.id) emit(uid, 'typing', { conv: convId, user: me.id, name: me.name });
      return send(res, 200, { ok: true });
    }
  }

  // ----- reactions, edit, delete for everyone, pin -----
  if ((m = /^\/api\/messages\/(\d+)\/(react|edit|delete|pin)$/.exec(path)) && M === 'POST') {
    const row = one('SELECT * FROM messages WHERE id = ?', Number(m[1]));
    if (!row || !canSee(me, row.conv_id)) throw err(404, 'Not found.');
    const ckind = one('SELECT kind FROM convs WHERE id = ?', row.conv_id).kind;
    const b = await readJson(req, 6000);
    const extra = row.extra ? JSON.parse(row.extra) : {};
    const save = (fields) => {
      const cols = Object.keys(fields);
      run(`UPDATE messages SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, ...cols.map((c) => fields[c]), row.id);
      const msg = rowToMsg(one('SELECT * FROM messages WHERE id = ?', row.id));
      for (const uid of memberIds(row.conv_id)) emit(uid, 'update', { msg });
      return msg;
    };
    if (m[2] === 'react') {                                 // one reaction per person; the same emoji again takes it back
      if (row.kind === 'deleted') throw err(400, 'That message was deleted.');
      const emoji = String(b.emoji || '');
      if (emoji && !REACTIONS.includes(emoji)) throw err(400, 'Unknown reaction.');
      const r = extra.reactions || {}, had = (r[emoji] || []).includes(me.id);
      for (const k of Object.keys(r)) { r[k] = r[k].filter((id) => id !== me.id); if (!r[k].length) delete r[k]; }
      if (emoji && !had) r[emoji] = [...(r[emoji] || []), me.id];
      if (emoji && !had) love.onReact(me, row, emoji);
      return send(res, 200, { msg: save({ extra: JSON.stringify({ ...extra, reactions: r }) }) });
    }
    if (m[2] === 'pin') {
      if (row.kind === 'deleted') throw err(400, 'That message was deleted.');
      if (one('SELECT 1 FROM pins WHERE conv_id = ? AND msg_id = ?', row.conv_id, row.id)) run('DELETE FROM pins WHERE conv_id = ? AND msg_id = ?', row.conv_id, row.id);
      else {
        if (one('SELECT count(*) AS n FROM pins WHERE conv_id = ?', row.conv_id).n >= 10) throw err(400, 'Up to 10 pinned messages per chat. Unpin one first.');
        run('INSERT INTO pins(conv_id, msg_id, by, at) VALUES(?,?,?,?)', row.conv_id, row.id, me.id, Date.now());
      }
      emitConv(row.conv_id);
      return send(res, 200, { ok: true });
    }
    // Edit and delete: only your own messages, and not in a bot chat (the job agent has already acted on them).
    if (row.user_id !== me.id) throw err(403, 'You can only change your own messages.');
    if (ckind === 'bot') throw err(400, 'Messages to your bot can\'t be changed.');
    if (row.kind === 'deleted') throw err(400, 'That message was deleted.');
    if (m[2] === 'edit') {
      if (row.kind !== 'text' && row.kind !== 'image' && row.kind !== 'video') throw err(400, 'Only text and captions can be edited.');
      const text = String(b.text || '').trim().slice(0, 4000);
      if (!text && row.kind === 'text') throw err(400, 'Empty message.');
      return send(res, 200, { msg: save({ text: text || null, extra: JSON.stringify({ ...extra, edited: Date.now() }) }) });
    }
    // delete for everyone: the bubble stays as "This message was deleted"; the text and any file are gone for good
    if (row.media) { try { unlinkSync(join(MEDIA, row.media.split('|')[0])); } catch { /* already gone */ } }
    run('DELETE FROM pins WHERE msg_id = ?', row.id);
    const msg = save({ kind: 'deleted', text: null, media: null, duration: null, extra: JSON.stringify({ deleted: Date.now() }) });
    emitConv(row.conv_id);
    return send(res, 200, { msg });
  }

  // ----- search across all my chats (text, captions, file names) -----
  if (M === 'GET' && path === '/api/search') {
    const q = String(query.q || '').trim().slice(0, 60);
    if (q.length < 2) return send(res, 200, { results: [] });
    const like = `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    const rows = all(`SELECT m.* FROM messages m JOIN members mb ON mb.conv_id = m.conv_id AND mb.user_id = ?
      WHERE m.kind IN ('text','card','image','video','file') AND (m.text LIKE ? ESCAPE '\\' OR json_extract(m.extra, '$.name') LIKE ? ESCAPE '\\')
      ORDER BY m.id DESC LIMIT 60`, me.id, like, like);
    const titles = new Map();
    const title = (id) => { if (!titles.has(id)) titles.set(id, convSummary(id, me).title); return titles.get(id); };
    return send(res, 200, { results: rows.map((r) => ({ msg: rowToMsg(r), title: title(r.conv_id) })) });
  }

  if ((m = /^\/api\/messages\/(\d+)\/action$/.exec(path)) && M === 'POST') {
    const row = one('SELECT * FROM messages WHERE id = ?', Number(m[1]));
    if (!row || !canSee(me, row.conv_id)) throw err(404, 'Not found.');
    const b = await readJson(req, 1000);
    if (row.user_id === botId() && row.extra && JSON.parse(row.extra).event) return send(res, 200, { msg: await together.action(me, row, String(b.action || '')) });
    if (row.user_id === botId() && row.extra && JSON.parse(row.extra).love) return send(res, 200, { msg: await love.action(me, row, String(b.action || '')) });
    if (one('SELECT kind FROM convs WHERE id = ?', row.conv_id).kind !== 'bot') throw err(404, 'Not found.');
    const msg = await botAction({ row, action: String(b.action || ''), say: (t, e) => botSay(t, e, me), update: updateMessage });
    return send(res, 200, { msg });
  }

  // ----- job dashboard: each person sees only their own job agent (found via agentFor), read-only plus a few actions -----
  if ((m = /^\/api\/jobs\/([a-z]+)$/.exec(path))) {
    const agent = agentFor(me);
    if (!agent) throw err(404, 'No job agent is set up for you yet.');
    const name = m[1];
    if (M === 'GET' && name === 'screen') {
      const r = await fetch(`${agent}/internal/dash/screen`, { signal: AbortSignal.timeout(10000) }).catch(() => null);
      if (r?.status !== 200) { res.writeHead(204, { 'Cache-Control': 'no-store' }); return res.end(); }
      const buf = Buffer.from(await r.arrayBuffer());
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'Content-Length': buf.length,
        'X-Task': r.headers.get('x-task') || '', 'X-Url': r.headers.get('x-url') || '' });
      return res.end(buf);
    }
    if (M === 'GET' && ['summary', 'list', 'detail', 'memory', 'referrals', 'log'].includes(name)) {
      const qs = new URLSearchParams(Object.entries(query).filter(([k]) => ['status', 'q', 'page', 'id', 'since'].includes(k)).map(([k, v]) => [k, String(v).slice(0, 200)]));
      const r = await fetch(`${agent}/internal/dash/${name}?${qs}`, { signal: AbortSignal.timeout(20000) }).catch(() => null);
      if (!r) throw err(503, 'Your job agent is not responding. It may be restarting.');
      return send(res, r.status, await r.json().catch(() => ({})));
    }
    // Settings → 💼 Job agent: the signed-in person's own agent only (agentFor maps the user server-side; the agent range-checks).
    if (name === 'settings' && (M === 'GET' || M === 'POST')) {
      const body = M === 'POST' ? JSON.stringify(await readJson(req, 2000)) : undefined;
      const r = await fetch(`${agent}/internal/settings`, { method: M, headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(10000) }).catch(() => null);
      if (!r) throw err(503, 'Your job agent is not responding. It may be restarting.');
      return send(res, r.status, await r.json().catch(() => ({})));
    }
    if (M === 'POST' && name === 'action') {
      const b = await readJson(req, 4000);
      if (!['answer', 'pause', 'resume', 'live', 'dry', 'skip', 'queue', 'claim', 'applied', 'forget', 'ref_decide', 'ref_companies'].includes(b.action)) throw err(400, 'Unknown action.');
      const r = await fetch(`${agent}/internal/action`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20000),
        body: JSON.stringify({ action: b.action, id: b.id, answer: typeof b.answer === 'string' ? b.answer.slice(0, 4000) : b.answer }) }).catch(() => null);
      if (!r?.ok) throw err(503, 'Your job agent is not responding. It may be restarting.');
      const out = await r.json().catch(() => ({}));
      if (out.ok === false) throw err(409, out.error || 'Your job agent refused that.');
      return send(res, 200, out);
    }
    if (M === 'POST' && name === 'signin') {                 // connect LinkedIn/Naukri from the dashboard
      const b = await readJson(req, 200);
      if (!/^(linkedin|naukri)$/.test(b.site || '')) throw err(400, 'Unknown site.');
      const token = randomBytes(16).toString('hex');
      setKv(`signin:${token}`, JSON.stringify({ uid: me.id, agent, site: b.site, exp: Date.now() + 2 * 3600e3 }));
      return send(res, 200, { path: `/signin/${token}` });
    }
    throw err(404, 'Not found.');
  }

  // ----- live sign-in page: the person signs in to LinkedIn/Naukri on the phone's browser, through their own agent -----
  // The token is single-person and short-lived; taps and keystrokes go to that person's agent only and are never logged.
  if ((m = /^\/api\/signin\/([a-f0-9]{32})(\/[a-z]+)?$/.exec(path))) {
    const s = JSON.parse(getKv(`signin:${m[1]}`) || 'null');
    if (!s || s.uid !== me.id || s.exp < Date.now()) throw err(404, 'This sign-in link has expired. Ask your job agent for a new one ("login linkedin").');
    const sub = m[2] || '', to = (p, init) => fetch(`${s.agent}/internal/signin/${p}`, { signal: AbortSignal.timeout(20000), ...init });
    if (M === 'GET' && sub === '') { const st = await to(`status?site=${s.site}`).then((r) => r.json()).catch(() => ({})); return send(res, 200, { site: s.site, ...st }); }
    if (M === 'POST' && sub === '/start') { const r = await to('start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ site: s.site }) }); return send(res, r.status, await r.json().catch(() => ({}))); }
    if (M === 'GET' && sub === '/frame') {
      const r = await to(`frame?site=${s.site}`).catch(() => null);
      if (!r?.ok) { res.writeHead(204, { 'Cache-Control': 'no-store' }); return res.end(); }
      const buf = Buffer.from(await r.arrayBuffer());
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'Content-Length': buf.length }); return res.end(buf);
    }
    if (M === 'POST' && sub === '/input') {
      if (!rateOk(me.id)) throw err(429, 'Slow down a little.');
      const b = await readJson(req, 2000);
      const r = await to('input', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ site: s.site, kind: b.kind, x: b.x, y: b.y, text: b.text, key: b.key }) });
      return send(res, r.status, await r.json().catch(() => ({})));
    }
    throw err(404, 'Not found.');
  }

  if (await together.route(req, res, path, query, me)) return;
  if (await wedding.route(req, res, path, query, me)) return;
  if (await calls.route(req, res, path, query, me)) return;

  if ((m = /^\/api\/media\/(\d+)$/.exec(path)) && M === 'GET') {
    const row = one('SELECT * FROM messages WHERE id = ?', Number(m[1]));
    if (!row?.media || !canSee(me, row.conv_id)) throw err(404, 'Not found.');
    const [file, type] = row.media.split('|');
    const full = join(MEDIA, file);
    if (!existsSync(full)) throw err(404, 'Not found.');
    return sendMedia(req, res, full, type, row.extra ? JSON.parse(row.extra).name : null);
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
// POST /notify {title?, text, actions?: [{id, label, style?}], ref?, replyTo?, to?, agent?}
//   replyTo: a local URL (http://127.0.0.1:<port>/...) that receives {text|action, ref} when the owner answers.
//   to: a username to message instead of the owner (a friend's own job agent); agent: that agent's local base URL,
//       remembered so the person's free-text questions and attached files reach their agent.
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
      const link = b.link && /^\/signin\/[a-f0-9]{32}$/.test(b.link.path || '') ? { label: String(b.link.label || 'Open').slice(0, 40), path: b.link.path } : null;
      const links = Array.isArray(b.links) ? b.links.filter((l) => /^https:\/\/[^\s"'<>]+$/.test(String(l?.url || ''))).slice(0, 6)
        .map((l) => ({ label: String(l.label || 'Open ↗').slice(0, 40), url: String(l.url).slice(0, 1000) })) : [];
      const extra = { title: String(b.title || '').slice(0, 40) || null, actions, ref: b.ref ?? null, replyTo, link, ...(links.length ? { links } : {}) };
      let target = o;
      if (b.to) {
        target = one("SELECT * FROM users WHERE username = ? AND active = 1 AND role != 'bot'", String(b.to).toLowerCase());
        if (!target) return send(res, 404, { error: `No Cupboard user ${b.to}`, pushable: false });
        if (/^http:\/\/127\.0\.0\.1:\d+$/.test(b.agent || '') && target.role !== 'owner') setKv(`agent:${target.id}`, b.agent);
      }
      const convId = b.chat === 'ncr' ? ncrConv(target) : botConv(target);
      if (b.chat === 'ncr' && /^http:\/\/127\.0\.0\.1:\d+$/.test(b.agent || '')) setKv(`ncragent:${target.id}`, b.agent);
      for (const p of (Array.isArray(b.images) ? b.images : []).slice(0, 8)) {    // screenshots first, then the card about them
        const m = shotToMedia(p);
        if (m) await postMessage(convId, botId(), { kind: 'image', media: m.media, extra: { name: 'screenshot.png', size: m.size, w: m.w, h: m.h } }, { pushOnly: [] });
      }
      // silent: no phone notification (a batch of job cards pings once, through its own summary message)
      const msg = await postMessage(convId, botId(), { kind: 'card', text, extra }, b.silent === true ? { pushOnly: [] } : {});
      return send(res, 200, { id: msg.id, pushable: push.hasPush(target.id) });
    }
    if (req.url === '/love') {                          // the server's own sweet notes to her: {text, ask?, partner?}
      const text = String(b.text || '').trim().slice(0, 600);
      if (!text) return send(res, 400, { error: 'text required' });
      if (b.partner) { const u = one("SELECT id FROM users WHERE username = ? AND active = 1 AND role != 'bot'", String(b.partner).toLowerCase()); if (!u) return send(res, 404, { error: 'no such user' }); setKv('love_partner', u.id); }
      const ask = Array.isArray(b.ask) ? b.ask.slice(0, 3).map((a) => ({ id: String(a.id).slice(0, 20), label: String(a.label).slice(0, 30), style: a.style === 'go' ? 'go' : '' })) : null;
      const r = await love.send({ text, ask, now: b.now === true, title: String(b.title || '💌 A little note for you').slice(0, 40), pushTitle: String(b.pushTitle || '💌 A little note for you').slice(0, 60) });
      return send(res, 200, r.queued ? { queued: r.queued } : { id: r.id, conv: r.conv });
    }
    if (req.url === '/calls-active') return send(res, 200, { active: calls.activeCount() });   // deploy.sh: never restart under a live call
    if (req.url === '/device-link') return send(res, 200, { path: deviceLink(o.id) });   // add-device.sh: when no trusted device is at hand
    if (req.url === '/signin') {                       // a job agent asks for a sign-in page link for one of its people
      const u = one("SELECT * FROM users WHERE username = ? AND active = 1 AND role != 'bot'", String(b.to || '').toLowerCase());
      if (!u || !/^http:\/\/127\.0\.0\.1:\d+$/.test(b.agent || '') || !/^(linkedin|naukri)$/.test(b.site || '')) return send(res, 400, { error: 'bad request' });
      const token = randomBytes(16).toString('hex');
      setKv(`signin:${token}`, JSON.stringify({ uid: u.id, agent: b.agent, site: b.site, exp: Date.now() + 2 * 3600e3 }));
      return send(res, 200, { path: `/signin/${token}` });
    }
    if (req.url === '/redact') {                       // a message carried a secret: keep the bubble, drop the text
      const row = one("SELECT * FROM messages WHERE id = ? AND kind = 'text'", Number(b.id));
      if (!row) return send(res, 404, { error: 'Not found' });
      run('UPDATE messages SET text = ? WHERE id = ?', String(b.text || '🔒 (hidden)').slice(0, 200), row.id);
      const msg = rowToMsg(one('SELECT * FROM messages WHERE id = ?', row.id));
      for (const uid of memberIds(row.conv_id)) emit(uid, 'update', { msg });
      return send(res, 200, { ok: true });
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
setInterval(() => { run('DELETE FROM sessions WHERE expires < ?', Date.now()); run('DELETE FROM invites WHERE used_by IS NULL AND expires < ?', Date.now());
  for (const r of all("SELECT k, v FROM kv WHERE k LIKE 'signin:%'")) if (JSON.parse(r.v).exp < Date.now()) run('DELETE FROM kv WHERE k = ?', r.k); }, 6 * 3600e3);
export { db };
