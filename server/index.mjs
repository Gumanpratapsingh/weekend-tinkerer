// Tinker server: one small process for every weekend-tinkerer feature.
// Listens on localhost only; nginx on the phone proxies /hub/api/* to it.
// Every /api route except login requires a session cookie: the owner's (everything), or a person's own login
// (their job agent's pages only, people/<name>/; they set the password themselves through an invite link).
import { createServer } from 'node:http';
import {
  send, readBody, visitorIp, log, push, passwordSet, checkPassword, loginLocked, noteFailure,
  newSession, endSession, sessionOf, sessionWho, sessionFull, cookie, checkPerson, personFull, inviteOf, useInvite,
} from './core.mjs';
import { existsSync } from 'node:fs';
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
import { smsIngest } from './modules/banksms.mjs';

const PORT = 8082;
const MODULES = [expenses, interview, linkedin, tamil, room, status, jobs, laptop];
const routes = Object.assign({}, ...MODULES.map((m) => m.routes || {}));

async function login(req, res) {
  const ip = visitorIp(req);
  if (loginLocked(ip)) return send(res, 429, { error: 'Too many attempts. Try again in 15 minutes.' });
  let body;
  try { body = await readBody(req, 1000); } catch { return send(res, 400, { error: 'Bad request' }); }
  const who = String(body.user || '').trim().toLowerCase();       // empty: the owner
  const ok = who ? isPerson(who) && checkPerson(who, body.password || '') : passwordSet() && checkPassword(body.password || '');
  if (!ok) {
    noteFailure(ip);
    log(`login failed from ${ip}${who ? ` as ${who}` : ''}`);
    push('Failed hub login', `Someone entered a wrong ${who ? `password for ${who}` : 'password'} on your tinker hub (IP ${ip}).`, { tags: 'warning', priority: 'high' });
    return send(res, 401, { error: who ? 'Wrong username or password.' : 'Wrong password.' });
  }
  log(`login ok from ${ip}${who ? ` as ${who}` : ''}`);
  return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(newSession(who, who && personFull(who)), 30 * 86400) });
}

// Someone with a job agent (people/<name>/port), who may have their own login.
const isPerson = (who) => /^[a-z0-9_-]{1,30}$/.test(who) && existsSync(join(HOME, 'jobagent', 'people', who, 'port'));

// One-time invite link: the person chooses their own password (nobody else ever sees it).
async function setup(req, res, url) {
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
  return send(res, 200, { ok: true, who: r.who, full: r.full }, { 'Set-Cookie': cookie(newSession(r.who, r.full), 30 * 86400) });
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

  if (key === 'POST /api/login') return login(req, res);
  if (key === 'GET /api/setup' || key === 'POST /api/setup') return setup(req, res, url);
  const token = sessionOf(req);
  const who = token ? sessionWho(token) : '';
  const limited = !!who && !sessionFull(token);                     // a person without full access
  if (key === 'GET /api/me') return send(res, 200, { loggedIn: !!token, passwordSet: passwordSet(), who, full: !limited });
  if (!token) return send(res, 401, { error: 'Log in first.' });
  if (key === 'POST /api/logout') { endSession(token); return send(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) }); }
  if (limited && !PERSON_ROUTES.test(key)) return send(res, 403, { error: 'Not available.' });

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
