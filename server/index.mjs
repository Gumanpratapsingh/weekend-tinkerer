// Tinker server: one small process for every weekend-tinkerer feature.
// Listens on localhost only; nginx on the phone proxies /hub/api/* to it.
// Every /api route except login requires a session cookie: the owner's (everything), or a person's own login
// (their job agent's pages only, people/<name>/; they set the password themselves through an invite link).
import { createServer } from 'node:http';
import {
  send, readBody, visitorIp, log, push, passwordSet, checkPassword, loginLocked, noteFailure,
  newSession, endSession, sessionOf, sessionWho, sessionFull, cookie, checkPerson, personFull, inviteOf, useInvite,
  deviceOf, trustDevice, deviceWho, deviceCookie, listDevices, removeDevice, makeDeviceLink, deviceLinkValid, useDeviceLink, loggedInBefore,
  makeInvite, sendEmail,
} from './core.mjs';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { HOME } from './core.mjs';
import expenses from './modules/expenses.mjs';
import interview from './modules/interview.mjs';
import linkedin from './modules/linkedin.mjs';
import tamil from './modules/tamil.mjs';
import room, { stream as roomStream } from './modules/room.mjs';
import status from './modules/status.mjs';
import jobs from './modules/jobs.mjs';
import laptop from './modules/laptop.mjs';
import reels from './modules/reels.mjs';
import { smsIngest } from './modules/banksms.mjs';

const PORT = 8082;
const MODULES = [expenses, interview, linkedin, tamil, room, status, jobs, laptop, reels];
const routes = Object.assign({}, ...MODULES.map((m) => m.routes || {}));

async function login(req, res, device) {
  const ip = visitorIp(req);
  if (loginLocked(ip)) return send(res, 429, { error: 'Too many attempts. Try again in 15 minutes.' });
  let body;
  try { body = await readBody(req, 1000); } catch { return send(res, 400, { error: 'Bad request' }); }
  const inputUser = String(body.user || '').trim().toLowerCase();
  const who = isOwnerInput(inputUser) && !inputUser.includes('@') ? '' : (findPerson(inputUser) || inputUser);
  const ok = who ? isPerson(who) && checkPerson(who, body.password || '') : passwordSet() && checkPassword(body.password || '');
  if (!ok) {
    noteFailure(ip);
    log(`login failed from ${ip}${who ? ` as ${who}` : ''}`);
    push('Failed hub login', `Someone entered a wrong ${who ? `password for ${who}` : 'password'} on your tinker hub (IP ${ip}).`, { tags: 'warning', priority: 'high' });
    return send(res, 401, { error: who ? 'Wrong username or password.' : 'Wrong password.' });
  }
  log(`login ok from ${ip}${who ? ` as ${who}` : ''}`);
  deviceWho(device.id, who || 'owner');
  return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(newSession(who, who && personFull(who)), 30 * 86400) });
}

// Someone with a job agent (people/<name>/port), who may have their own login.
const isPerson = (who) => /^[a-z0-9_-]{1,30}$/.test(who) && existsSync(join(HOME, 'jobagent', 'people', who, 'port'));

function findPerson(rawWho) {
  const norm = String(rawWho || '').trim().toLowerCase();
  if (!norm) return null;
  if (isPerson(norm)) return norm;
  const pdir = join(HOME, 'jobagent', 'people');
  if (!existsSync(pdir)) return null;
  try {
    for (const name of readdirSync(pdir)) {
      if (!isPerson(name)) continue;
      if (name.toLowerCase() === norm) return name;
      try {
        const privPath = join(pdir, name, 'profile', 'private.json');
        if (existsSync(privPath)) {
          const priv = JSON.parse(readFileSync(privPath, 'utf8'));
          if (priv.cupboard_user && priv.cupboard_user.toLowerCase() === norm) return name;
          if (priv.mailbox && priv.mailbox.toLowerCase() === norm) return name;
        }
      } catch {}
      try {
        const mastPath = join(pdir, name, 'profile', 'master.json');
        if (existsSync(mastPath)) {
          const mast = JSON.parse(readFileSync(mastPath, 'utf8'));
          if (mast.email && mast.email.toLowerCase() === norm) return name;
        }
      } catch {}
    }
  } catch {}
  return null;
}

const isOwnerInput = (rawWho) => {
  const norm = String(rawWho || '').trim().toLowerCase();
  if (!norm || norm === 'owner' || norm === 'guman' || norm === 'gumanpratap' || norm === 'gpsingh') return true;
  try {
    const priv = JSON.parse(readFileSync(join(HOME, 'jobagent', 'profile', 'private.json'), 'utf8'));
    if (priv.mailbox && priv.mailbox.toLowerCase() === norm) return true;
  } catch {}
  return false;
};

// One-time invite link: the person chooses their own password (nobody else ever sees it).
async function setup(req, res, url, device) {
  const ip = visitorIp(req);
  if (loginLocked(ip)) return send(res, 429, { error: 'Too many attempts. Try again in 15 minutes.' });
  if (req.method === 'GET') {
    const i = inviteOf(url.searchParams.get('t') || '');
    if (!i) noteFailure(ip);
    return send(res, 200, { valid: !!i });
  }
  let body;
  try { body = await readBody(req, 1000); } catch { return send(res, 400, { error: 'Bad request' }); }
  const pw = String(body.password || '');
  if (pw.length < 10) return send(res, 400, { error: 'Use at least 10 characters.' });
  const r = useInvite(body.token || '', pw);
  if (!r) { noteFailure(ip); return send(res, 400, { error: 'This link has expired or was already used. Ask Guman for a new one.' }); }
  log(`password set by ${r.who} from ${ip}`);
  push('Hub login ready', `${r.who} set their own hub password and is logged in.`, { tags: 'key' });
  // The invite link also trusts the browser it was opened in.
  return send(res, 200, { ok: true, who: r.who, full: r.full }, { 'Set-Cookie': [cookie(newSession(r.who, r.full), 30 * 86400), ...(device ? [] : [trustDevice(req, r.who, 'invite')])] });
}

async function forgotPassword(req, res, device) {
  const ip = visitorIp(req);
  if (loginLocked(ip)) return send(res, 429, { error: 'Too many attempts. Try again in 15 minutes.' });
  let body;
  try { body = await readBody(req, 1000); } catch { return send(res, 400, { error: 'Bad request' }); }
  const rawWho = String(body.user || '').trim().toLowerCase();
  let who = '';
  let isOwner = false;
  if (isOwnerInput(rawWho)) {
    isOwner = true;
    who = '';
  } else {
    const matched = findPerson(rawWho);
    if (!matched) {
      noteFailure(ip);
      return send(res, 404, { error: 'No account found with that username or email.' });
    }
    who = matched;
  }

  const full = isOwner || personFull(who);
  const token = makeInvite(who, full, 2);

  try {
    const { execSync } = await import('node:child_process');
    execSync('scp -o BatchMode=yes -o ConnectTimeout=3 ~/tinker/invites.json s20phone:tinker/invites.json 2>/dev/null || true');
  } catch {}

  const host = req.headers.host || 'tinker.gumanpratap.workers.dev';
  const resetUrl = `https://${host}/setup?t=${token}`;

  let targetEmail = '';
  let name = isOwner ? 'Guman' : who;
  if (isOwner) {
    try {
      const priv = JSON.parse(readFileSync(join(HOME, 'jobagent', 'profile', 'private.json'), 'utf8'));
      targetEmail = priv.mailbox || '';
    } catch {}
  } else {
    try {
      const priv = JSON.parse(readFileSync(join(HOME, 'jobagent', 'people', who, 'profile', 'private.json'), 'utf8'));
      targetEmail = priv.mailbox || '';
    } catch {}
    try {
      const mast = JSON.parse(readFileSync(join(HOME, 'jobagent', 'people', who, 'profile', 'master.json'), 'utf8'));
      name = mast.name || who;
    } catch {}
  }

  push('Password reset requested', `${name} requested a password reset on Tinker Hub.\nLink: ${resetUrl}`, { tags: 'key', priority: 'high' });

  let emailSent = false;
  if (targetEmail) {
    emailSent = await sendEmail({
      to: targetEmail,
      subject: 'Tinker Hub — Password Reset Link',
      text: `Hi ${name},\n\nYou requested to reset your password for Tinker Hub.\nOpen this link to choose a new password (valid for 2 hours):\n\n${resetUrl}\n\nIf you did not request this, you can ignore this email.`,
      html: `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;max-width:480px;margin:20px auto;padding:24px;border:1px solid #e5e5e7;border-radius:12px;background:#ffffff;">
        <h2 style="color:#1d1d1f;margin-top:0;font-size:22px;">Reset your password</h2>
        <p style="color:#515154;font-size:15px;line-height:1.5;">Hi ${name}, click below to choose a new password for the Tinker Hub. This link is valid for 2 hours.</p>
        <p style="text-align:center;margin:28px 0;"><a href="${resetUrl}" style="background:#0071e3;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;display:inline-block;font-size:15px;">Reset Password</a></p>
        <p style="color:#86868b;font-size:12px;line-height:1.4;margin-bottom:0;">If you didn't request this, you can safely ignore this email.</p>
      </div>`
    });
  }

  log(`password reset requested for ${who || 'owner'} (email sent: ${emailSent})`);

  const mask = (em) => {
    if (!em || !em.includes('@')) return '';
    const [u, d] = em.split('@');
    return u.length <= 2 ? `${u[0]}*@${d}` : `${u[0]}***${u.slice(-1)}@${d}`;
  };

  return send(res, 200, {
    ok: true,
    who: who || 'owner',
    email: mask(targetEmail),
    ...(device ? { resetUrl, token } : {})
  });
}

// What a person's login may use: their own job agent's pages. Their name is forced onto every call.
const PERSON_ROUTES = /^(GET \/api\/jobs(\/(people|list|detail|file|log|screen|errors|evidence|referrals|memory))?|POST \/api\/jobs\/action)$/;

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname.replace(/^\/hub/, '');
  const key = `${req.method} ${path.replace(/\/[0-9a-f-]{8,}$/i, '/:id')}`;

  // Bank SMS from the iPhone automation: authenticated by its own secret token, not the login cookie.
  if (key === 'POST /api/expenses/sms') return smsIngest(req, res);

  // CSRF: state-changing requests must come from our own page (custom header can't be sent cross-site
  // without CORS, and SameSite=Strict keeps the cookie off cross-site requests anyway).
  if (req.method !== 'GET' && req.headers['x-hub'] !== '1') return send(res, 403, { error: 'Forbidden' });

  // Trusted devices only: an unknown browser can use an add-device link or a person's invite link, nothing else.
  const device = deviceOf(req);
  if (!device) {
    if (key === 'GET /api/device') return send(res, 200, { valid: deviceLinkValid(url.searchParams.get('t')) });
    if (key === 'POST /api/device') {
      const c = useDeviceLink(String((await readBody(req)).token || ''), req);
      return c ? send(res, 200, { ok: true }, { 'Set-Cookie': c }) : send(res, 410, { error: 'This add-device link has expired or was already used. Make a new one on a trusted device (Devices).' });
    }
    if (key === 'GET /api/me') {
      const t = sessionOf(req);
      if (loggedInBefore(t)) return send(res, 200, { loggedIn: true, passwordSet: passwordSet(), who: sessionWho(t), full: sessionFull(t), device: true },
        { 'Set-Cookie': trustDevice(req, sessionWho(t) || 'owner', 'already logged in') });
      return send(res, 200, { device: false });
    }
    if (key !== 'GET /api/setup' && key !== 'POST /api/setup' && key !== 'POST /api/forgot-password') return send(res, 404, { error: 'Not found' });
  }
  if (key === 'POST /api/login') return login(req, res, device);
  if (key === 'POST /api/forgot-password') return forgotPassword(req, res, device);
  if (key === 'GET /api/setup' || key === 'POST /api/setup') return setup(req, res, url, device);
  const token = sessionOf(req);
  const who = token ? sessionWho(token) : '';
  const limited = !!who && !sessionFull(token);                     // a person without full access
  if (key === 'GET /api/me') return send(res, 200, { loggedIn: !!token, passwordSet: passwordSet(), who, full: !limited, device: true });
  if (!token) return send(res, 401, { error: 'Log in first.' });
  if (key === 'POST /api/logout') { endSession(token); return send(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) }); }
  if (limited && !PERSON_ROUTES.test(key)) return send(res, 403, { error: 'Not available.' });
  if (key === 'GET /api/devices') return send(res, 200, { devices: listDevices().map((d) => ({ ...d, current: d.id === device.id })) });
  if (key === 'POST /api/devices/link') return send(res, 200, { token: makeDeviceLink(who || 'owner') });
  if (key === 'DELETE /api/devices/:id') {
    const id = /\/([0-9a-f]{16})$/.exec(path)?.[1];
    if (!id || !removeDevice(id)) return send(res, 404, { error: 'Not found' });
    log(`device removed by ${who || 'owner'}`);
    return send(res, 200, { ok: true }, id === device.id ? { 'Set-Cookie': deviceCookie('') } : {});
  }

  if (key === 'GET /api/room/stream') return roomStream(req, res);   // long-lived SSE, owner-only like the rest
  const handler = routes[key];
  if (!handler) return send(res, 404, { error: 'Not found' });
  try {
    const body = req.method === 'GET' ? {} : await readBody(req);
    const id = /\/([0-9a-f-]{8,})$/i.exec(path)?.[1];
    const query = Object.fromEntries(url.searchParams);
    if (limited) { query.who = who; body.who = who; }               // a limited person only ever sees their own agent
    const out = await handler({ body, query, id });
    if (limited && key === 'GET /api/jobs/people') out.people = out.people.filter((p) => p.who === who);
    return send(res, 200, out);
  } catch (e) {
    log(`${key}: ${e.message}`);
    return send(res, e.status || 500, { error: e.expose ? e.message : 'Something went wrong.' });
  }
}).listen(PORT, '127.0.0.1', () => {
  for (const m of MODULES) m.start?.();
  log(`tinker server on 127.0.0.1:${PORT} with ${MODULES.length} modules`);
});
