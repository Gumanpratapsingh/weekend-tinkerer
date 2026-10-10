// Shared plumbing for the tinker server: storage, HTTP helpers, auth, ntfy, Groq, schedules.
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, renameSync } from 'node:fs';
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
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
let sessions = load('sessions.json', {});                 // token -> expiry ms
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

export function newSession() {
  const token = randomBytes(32).toString('hex');
  sessions[token] = Date.now() + SESSION_DAYS * 86400e3;
  for (const [t, exp] of Object.entries(sessions)) if (exp < Date.now()) delete sessions[t];
  save('sessions.json', sessions);
  return token;
}
export function endSession(token) { delete sessions[token]; save('sessions.json', sessions); }

export function sessionOf(req) {
  const m = /(?:^|;\s*)tk=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  return m && sessions[m[1]] > Date.now() ? m[1] : null;
}
export const cookie = (token, maxAge) =>
  `tk=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
