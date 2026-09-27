// Tinker server: one small process for every weekend-tinkerer feature.
// Listens on localhost only; nginx on the phone proxies /hub/api/* to it.
// Every /api route except login requires the owner's session cookie.
import { createServer } from 'node:http';
import {
  send, readBody, visitorIp, log, push, passwordSet, checkPassword, loginLocked, noteFailure,
  newSession, endSession, sessionOf, cookie,
} from './core.mjs';
import expenses from './modules/expenses.mjs';
import interview from './modules/interview.mjs';
import linkedin from './modules/linkedin.mjs';
import tamil from './modules/tamil.mjs';
import room from './modules/room.mjs';

const PORT = 8082;
const MODULES = [expenses, interview, linkedin, tamil, room];
const routes = Object.assign({}, ...MODULES.map((m) => m.routes || {}));

async function login(req, res) {
  const ip = visitorIp(req);
  if (loginLocked(ip)) return send(res, 429, { error: 'Too many attempts. Try again in 15 minutes.' });
  let body;
  try { body = await readBody(req, 1000); } catch { return send(res, 400, { error: 'Bad request' }); }
  if (!passwordSet()) return send(res, 503, { error: 'No password set yet.' });
  if (!checkPassword(body.password || '')) {
    noteFailure(ip);
    log(`login failed from ${ip}`);
    push('Failed hub login', `Someone entered a wrong password for your tinker hub (IP ${ip}).`, { tags: 'warning', priority: 'high' });
    return send(res, 401, { error: 'Wrong password.' });
  }
  log(`login ok from ${ip}`);
  return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(newSession(), 30 * 86400) });
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname.replace(/^\/hub/, '');
  const key = `${req.method} ${path.replace(/\/[0-9a-f-]{8,}$/i, '/:id')}`;

  // CSRF: state-changing requests must come from our own page (custom header can't be sent cross-site
  // without CORS, and SameSite=Strict keeps the cookie off cross-site requests anyway).
  if (req.method !== 'GET' && req.headers['x-hub'] !== '1') return send(res, 403, { error: 'Forbidden' });

  if (key === 'POST /api/login') return login(req, res);
  const token = sessionOf(req);
  if (key === 'GET /api/me') return send(res, 200, { loggedIn: !!token, passwordSet: passwordSet() });
  if (!token) return send(res, 401, { error: 'Log in first.' });
  if (key === 'POST /api/logout') { endSession(token); return send(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) }); }

  const handler = routes[key];
  if (!handler) return send(res, 404, { error: 'Not found' });
  try {
    const body = req.method === 'GET' ? {} : await readBody(req);
    const id = /\/([0-9a-f-]{8,})$/i.exec(path)?.[1];
    return send(res, 200, await handler({ body, query: Object.fromEntries(url.searchParams), id }));
  } catch (e) {
    log(`${key}: ${e.message}`);
    return send(res, e.status || 500, { error: e.expose ? e.message : 'Something went wrong.' });
  }
}).listen(PORT, '127.0.0.1', () => {
  for (const m of MODULES) m.start?.();
  log(`tinker server on 127.0.0.1:${PORT} with ${MODULES.length} modules`);
});
