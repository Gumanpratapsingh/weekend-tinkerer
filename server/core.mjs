// Shared plumbing for the tinker server: storage, HTTP helpers, auth, ntfy, Groq, schedules.
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, renameSync } from 'node:fs';
import { scryptSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const HOME = homedir();
export const DATA = join(HOME, 'tinker', 'data');
mkdirSync(DATA, { recursive: true, mode: 0o700 });

// ---------- storage: small JSON files, written atomically ----------
export function load(name, fallback) {
  const f = join(DATA, name);
  try { return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : fallback; } catch { return fallback; }
}
export function save(name, value) {
  const f = join(DATA, name);
  writeFileSync(f + '.tmp', JSON.stringify(value), { mode: 0o600 });
  renameSync(f + '.tmp', f);
}
export function log(line) {
  appendFileSync(join(DATA, 'server.log'), `${new Date().toISOString()} ${line}\n`);
}

// ---------- time (everything is scheduled in IST) ----------
export const IST = 5.5 * 3600e3;
export const istNow = () => new Date(Date.now() + IST);                 // read with getUTC*
export const istDate = (t = Date.now()) => new Date(t + IST).toISOString().slice(0, 10);
export const istMonth = (t = Date.now()) => istDate(t).slice(0, 7);

// Run fn every day at hh:mm IST (optionally only on some weekdays, 0 = Sunday).
export function daily(hh, mm, fn, { days } = {}) {
  const next = () => {
    const now = Date.now();
    const n = istNow();
    let t = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate(), hh, mm) - IST;
    while (t <= now || (days && !days.includes(new Date(t + IST).getUTCDay()))) t += 86400e3;
    setTimeout(async () => {
      try { await fn(); } catch (e) { log(`schedule error: ${e.message}`); }
      next();
    }, t - now);
  };
  next();
}

// ---------- HTTP helpers ----------
export function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}
export function readBody(req, limit = 16_000) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > limit) { req.destroy(); reject(new Error('too large')); } });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('bad json')); } });
  });
}
export const visitorIp = (req) => String(req.headers['x-visitor-ip'] || req.headers['cf-connecting-ip'] || 'unknown');

// ---------- ntfy ----------
export const TOPIC = readFileSync(join(HOME, 'room', 'ntfy-topic'), 'utf8').trim();
// The owner's chat app (Cupboard, same phone) gets alerts first; ntfy stays as the fallback until Cupboard
// reports a device with notifications on ("pushable"), and whenever Cupboard is down.
export async function cupboard(payload) {
  try {
    const r = await fetch('http://127.0.0.1:8086/notify', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(4000) });
    return r.ok && (await r.json()).pushable === true;
  } catch { return false; }
}
export async function push(title, body, { tags = '', priority = 'default', actions } = {}) {
  if (await cupboard({ title, text: body, actions })) return;
  try {
    await fetch(`https://ntfy.sh/${TOPIC}`, {
      method: 'POST', body,
      headers: { Title: title.replace(/[^\x20-\x7e]/g, ''), Tags: tags, Priority: priority },
    });
  } catch (e) { log(`ntfy error: ${e.message}`); }
}
// Stream messages published to "<topic>-<suffix>" and hand each text to onMessage. Reconnects forever.
export function listen(suffix, onMessage) {
  const run = async () => {
    try {
      const r = await fetch(`https://ntfy.sh/${TOPIC}-${suffix}/json`);
      let buf = '';
      for await (const chunk of r.body) {
        buf += Buffer.from(chunk).toString('utf8');
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          let m; try { m = JSON.parse(line); } catch { continue; }
          if (m.event === 'message' && m.message) {
            try { await onMessage(String(m.message).trim()); } catch (e) { log(`${suffix} handler: ${e.message}`); }
          }
        }
      }
    } catch (e) { log(`listen ${suffix}: ${e.message}`); }
    setTimeout(run, 5000);
  };
  run();
}

// ---------- Groq ----------
const MODELS = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'];
export async function groq(messages, { maxTokens = 900, json = false, temperature = 0.4 } = {}) {
  const key = readFileSync(join(HOME, '.groq_key'), 'utf8').trim();
  for (const model of MODELS) {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens, reasoning_effort: 'low',
        include_reasoning: false, ...(json ? { response_format: { type: 'json_object' } } : {}) }),
      signal: AbortSignal.timeout(45000),
    });
    if (r.status === 429 || r.status === 404) continue;
    if (!r.ok) throw new Error(`Groq ${r.status}`);
    const text = (await r.json()).choices?.[0]?.message?.content?.trim() || '';
    return json ? JSON.parse(text) : text;
  }
  throw new Error('Groq rate limited');
}

// ---------- auth: one owner password (scrypt hash) + server-side sessions ----------
const AUTH_FILE = join(HOME, 'tinker', 'auth.json');     // {salt, hash}, written by set-password.sh
const SESSION_DAYS = 30;
let sessions = load('sessions.json', {});                 // token -> expiry ms (owner) or {exp, who, full} (a person)
const attempts = new Map();                               // ip -> [timestamps]

export function passwordSet() { return existsSync(AUTH_FILE); }

export function checkPassword(pw) {
  if (!passwordSet()) return false;
  const { salt, hash } = JSON.parse(readFileSync(AUTH_FILE, 'utf8'));
  const got = scryptSync(String(pw), Buffer.from(salt, 'hex'), 64);
  return timingSafeEqual(got, Buffer.from(hash, 'hex'));
}

export function loginLocked(ip) {
  const recent = (attempts.get(ip) || []).filter((t) => Date.now() - t < 15 * 60e3);
  attempts.set(ip, recent);
  return recent.length >= 5;
}
export function noteFailure(ip) { attempts.set(ip, [...(attempts.get(ip) || []), Date.now()]); }

const expOf = (v) => (typeof v === 'number' ? v : v?.exp || 0);
export function newSession(who = '', full = false) {
  const token = randomBytes(32).toString('hex');
  const exp = Date.now() + SESSION_DAYS * 86400e3;
  sessions[token] = who ? { exp, who, full: !!full } : exp;
  for (const [t, v] of Object.entries(sessions)) if (expOf(v) < Date.now()) delete sessions[t];
  save('sessions.json', sessions);
  return token;
}
export function endSession(token) { delete sessions[token]; save('sessions.json', sessions); }

export function sessionOf(req) {
  const m = /(?:^|;\s*)tk=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  return m && expOf(sessions[m[1]]) > Date.now() ? m[1] : null;
}
// '' for the owner; a person's name (people/<name>/ job agent) for their own login. A person sees only their
// own job agent, unless the owner gave them full access (everything the owner sees).
export const sessionWho = (token) => (typeof sessions[token] === 'object' ? sessions[token].who : '');
export const sessionFull = (token) => typeof sessions[token] !== 'object' || !!sessions[token].full;

// ---------- people: their own login, set by themselves through a one-time invite link ----------
const PEOPLE_AUTH = join(HOME, 'tinker', 'people-auth.json');   // {name: {salt, hash, full}}
const INVITES = join(HOME, 'tinker', 'invites.json');           // {token: {who, exp, full}}, made by invite-person.sh
const readJ = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return {}; } };
const writeJ = (f, v) => writeFileSync(f, JSON.stringify(v), { mode: 0o600 });
export function checkPerson(who, pw) {
  const a = readJ(PEOPLE_AUTH)[who];
  if (!a) return false;
  return timingSafeEqual(scryptSync(String(pw), Buffer.from(a.salt, 'hex'), 64), Buffer.from(a.hash, 'hex'));
}
export const personFull = (who) => !!readJ(PEOPLE_AUTH)[who]?.full;
export function inviteOf(token) {
  const i = readJ(INVITES)[String(token)];
  return i && i.exp > Date.now() ? i : null;
}
export function makeInvite(who = '', full = false, hours = 2) {
  const token = randomBytes(24).toString('hex');
  const inv = readJ(INVITES);
  inv[token] = { who, full: !!full, exp: Date.now() + hours * 3600e3, reset: true };
  writeJ(INVITES, inv);
  return token;
}

export async function sendEmail({ to, subject, text, html }) {
  if (!to) return false;
  try {
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    const nodemailer = req(join(HOME, 'jobagent', 'node_modules', 'nodemailer'));
    const pwPath = join(HOME, '.jobagent', 'gmail_app_password');
    if (!existsSync(pwPath)) return false;
    const pass = readFileSync(pwPath, 'utf8').trim();
    const from = 'gumanpratapsinghparmar@gmail.com';
    const smtp = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: from, pass } });
    await smtp.sendMail({ from: `Tinker Hub <${from}>`, to, subject, text, html });
    return true;
  } catch (e) {
    log(`sendEmail failed: ${e.message}`);
    return false;
  }
}

export function useInvite(token, pw) {          // sets the person's or owner's password
  const i = inviteOf(token);
  if (!i) return null;
  const salt = randomBytes(16);
  const isOwner = !i.who || i.who === 'owner';
  if (isOwner) {
    writeJ(AUTH_FILE, { salt: salt.toString('hex'), hash: scryptSync(String(pw), salt, 64).toString('hex') });
    for (const [t, v] of Object.entries(sessions)) if (typeof v === 'number') delete sessions[t]; // clear old owner sessions
  } else {
    const auth = readJ(PEOPLE_AUTH);
    auth[i.who] = { salt: salt.toString('hex'), hash: scryptSync(String(pw), salt, 64).toString('hex'), full: !!i.full };
    writeJ(PEOPLE_AUTH, auth);
    for (const [t, v] of Object.entries(sessions)) if (typeof v === 'object' && v.who === i.who) delete sessions[t];   // old logins out
  }
  const inv = readJ(INVITES); delete inv[String(token)]; writeJ(INVITES, inv);
  save('sessions.json', sessions);
  return { who: isOwner ? '' : i.who, full: !!i.full };
}
// ---------- trusted devices: only browsers approved from a trusted one reach the hub at all ----------
// Unknown browsers get 404 for every API call (no login form to guess at). Browsers already logged in when this
// started are trusted on their next visit; a new one needs a 15-minute add-device link made on a trusted device.
let devices = load('devices.json', {});                    // sha256(token) -> {name, who, by, created, seen}
let devicesSince = load('devices-since.json', 0);
if (!devicesSince) { devicesSince = Date.now(); save('devices-since.json', devicesSince); }
let deviceLinks = load('device-links.json', {});           // token -> {by, exp}
const sha = (t) => createHash('sha256').update(t).digest('hex');
export const deviceCookie = (token) => `td=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${token ? 2 * 365 * 86400 : 0}`;
export function deviceOf(req) {
  const m = /(?:^|;\s*)td=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  if (!m) return null;
  const hash = sha(m[1]);
  const d = devices[hash] || devices[m[1]];
  if (!d) return null;
  const id = devices[hash] ? hash.slice(0, 16) : m[1].slice(0, 16);
  if (Date.now() - (d.seen || 0) > 3600e3) { d.seen = Date.now(); save('devices.json', devices); }
  return { id, ...d };
}
function deviceName(req) {
  const ua = String(req.headers['user-agent'] || '');
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows PC' : 'Browser';
  const br = /Edg\//.test(ua) ? 'Edge' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  return `${os}${br ? ` · ${br}` : ''}`;
}
export function trustDevice(req, who, by) {                // returns the Set-Cookie value
  const token = randomBytes(32).toString('hex');
  devices[sha(token)] = { name: deviceName(req), who, by, created: Date.now(), seen: Date.now() };
  save('devices.json', devices);
  return deviceCookie(token);
}
export function deviceWho(id, who) { const k = Object.keys(devices).find((h) => h.startsWith(id)); if (k) { devices[k].who = who; save('devices.json', devices); } }
export const listDevices = () => Object.entries(devices).map(([h, d]) => ({ id: h.slice(0, 16), ...d })).sort((a, b) => (b.seen || 0) - (a.seen || 0));
export function removeDevice(id) {
  const k = Object.keys(devices).find((h) => h.startsWith(String(id)));
  if (!k || String(id).length !== 16) return false;
  delete devices[k]; save('devices.json', devices); return true;
}
export function makeDeviceLink(by) {
  deviceLinks = load('device-links.json', {});
  for (const [t, v] of Object.entries(deviceLinks)) if (v.exp < Date.now()) delete deviceLinks[t];
  const token = randomBytes(16).toString('hex');
  deviceLinks[token] = { by, exp: Date.now() + 15 * 60e3 };
  save('device-links.json', deviceLinks);
  return token;
}
// Read fresh each time: add-device.sh on the server can write a link too.
export const deviceLinkValid = (token) => ((deviceLinks = load('device-links.json', {}))[String(token)]?.exp || 0) > Date.now();
export function useDeviceLink(token, req) {
  if (!deviceLinkValid(token)) return null;
  const by = deviceLinks[token].by; delete deviceLinks[token]; save('device-links.json', deviceLinks);
  return trustDevice(req, null, by);
}
// A login that already existed before devices were required (sessions last SESSION_DAYS).
export const loggedInBefore = (token) => !!token && expOf(sessions[token]) - SESSION_DAYS * 86400e3 < devicesSince;

export const cookie = (token, maxAge) =>
  `tk=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
