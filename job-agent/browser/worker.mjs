// Browser worker: runs inside the Debian proot under Xvfb (headed Chromium — Naukri's Akamai blocks headless).
// Listens on 127.0.0.1:8084. The agent (Termux) posts tasks; each site module exports async handlers.
// The jobagent folder is bind-mounted at the same path, so file paths are shared with the agent.
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, getBrowser, begin, end } from './session.mjs';
import * as session from './session.mjs';
import { writeFileSync, renameSync, statSync } from 'node:fs';

// ---------- tasks ----------
const tasks = {
  async ping() { await getBrowser(); return { ok: true, version: (await getBrowser()).version() }; },
  async rest() { await session.closeBrowser(); return { ok: true }; },   // thermal guard: free the CPU

  // Diagnostics: open a URL with a site's session, report what loaded, save a screenshot.
  async probe({ url, site = 'probe', click = null }) {
    const { siteContext, shotPath } = await import('./session.mjs');
    const ctx = await siteContext(site);
    const page = await ctx.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(4000);
      let after = null;
      if (click) {                                      // diagnostics: click a button by its text, report what opened
        const popup = page.context().waitForEvent('page', { timeout: 8000 }).catch(() => null);
        await page.locator('button, a').filter({ hasText: click }).first().click({ timeout: 8000 }).catch((e) => { after = `click failed: ${e.message.slice(0, 120)}`; });
        const p2 = await popup;
        await page.waitForTimeout(5000);
        const target = p2 || page;
        after = after || { url: target.url(), newTab: !!p2, dialogs: await target.locator('div[role="dialog"]').count(),
          modalClass: await target.locator('[class*="easy-apply"], [data-test-modal-id]').count(), text: (await target.innerText('body')).slice(0, 600) };
      }
      const shot = shotPath(`probe-${site}`);
      await page.screenshot({ path: shot });
      return { url: page.url(), title: await page.title(), text: (await page.innerText('body')).slice(0, 1500), shot, after };
    } finally { await ctx.close(); }
  },

  // HTML file -> one-page PDF, shrinking the scale until it fits.
  async pdf({ html, pdf }) {
    const b = await getBrowser();
    const page = await b.newPage();
    try {
      await page.goto(`file://${html}`);
      let scale = 1;
      for (; scale > 0.8; scale -= 0.03) {
        const h = await page.evaluate(() => document.documentElement.scrollHeight);
        // Letter is 11in; minus 0.9in margins = 10.1in = 970 CSS px at 96dpi.
        if (h * scale <= 965) break;
      }
      await page.pdf({ path: pdf, format: 'Letter', printBackground: true, scale: Math.max(scale, 0.8),
        margin: { top: '0.45in', bottom: '0.45in', left: '0.5in', right: '0.5in' } });
      return { ok: true, scale: Number(scale.toFixed(2)) };
    } finally { await page.close(); }
  },
};

// Site modules (naukri, linkedin, ats) add their own tasks.
for (const mod of ['naukri', 'linkedin', 'ats', 'external']) {
  const f = join(ROOT, 'browser', `${mod}.mjs`);
  if (existsSync(f)) Object.assign(tasks, (await import(f)).default);
}

// A page closing mid-click must never take the whole worker down (it did on 2026-10-10 and stalled applying).
process.on('unhandledRejection', (e) => { console.error('unhandled rejection (kept running):', e?.message || e); session.workerError('unhandled', e); });
process.on('uncaughtException', (e) => { console.error('uncaught exception (kept running):', e?.message || e); session.workerError('uncaught', e); });

// Snapshot of the browser for the hub's live screen, every 2.5 s while a task runs (JPEG, ~50 KB).
// Written to the data folder of the person whose task is running; only while their /jobs/live page is open.
let current = null;                                   // { task, since, who }
setInterval(async () => {
  const p = session.livePage;
  if (!current || !p || p.isClosed()) return;
  const dir = current.who.data;
  try { if (Date.now() - statSync(join(dir, 'live-watch')).mtimeMs > 30e3) return; } catch { return; }
  try {
    const out = join(dir, 'live.jpg');
    await p.screenshot({ path: `${out}.tmp`, type: 'jpeg', quality: 55, timeout: 4000 });
    renameSync(`${out}.tmp`, out);
    writeFileSync(join(dir, 'live.json'), JSON.stringify({ task: current.task, url: p.url(), at: Date.now() }));
  } catch { /* page busy or navigating: next tick */ }
}, 2500);

const TASK_LIMIT = 12 * 60e3;                        // a hung task must not block the queue forever
const LIMITS = { naukri_search: 60 * 60e3, naukri_recommended: 10 * 60e3 };   // full searches legitimately take ~20 min
// One task at a time (the phone has one browser), taken in turns between people so nobody's queue starves the other's.
const waiting = [];                                  // [{ who, run }]
let running = false, lastPerson = null;
function pump() {
  if (running || !waiting.length) return;
  let i = waiting.findIndex((w) => w.who.person !== lastPerson);
  if (i < 0) i = 0;
  const [next] = waiting.splice(i, 1);
  running = true; lastPerson = next.who.person;
  session.person.run(next.who, next.run).finally(() => { running = false; pump(); });
}
// A task says whose it is (_who); data folders must be the owner's or one under people/, never anything else.
function whoOf(body) {
  const w = body._who; delete body._who;
  if (!w) return session.who();
  const name = String(w.person || '');
  if (!/^[a-z][a-z0-9_-]{0,30}$/.test(name)) throw new Error('bad person');
  const port = Number(w.port);
  if (!(port > 1024 && port < 65536)) throw new Error('bad port');
  return { person: name, data: name === 'owner' ? join(ROOT, 'data') : join(ROOT, 'people', name, 'data'), agent: `http://127.0.0.1:${port}` };
}
createServer((req, res) => {
  const reply = (code, body) => { if (res.headersSent) return; res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.url === '/health') return reply(200, { ok: true, pid: process.pid, waiting: waiting.length, running: current?.task || null, for: current?.who.person || null });   // instant, not queued
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const name = req.url.slice(1);
    if (!tasks[name]) return reply(404, { error: `no task ${name}` });
    let body, w;
    try { body = raw ? JSON.parse(raw) : {}; w = whoOf(body); } catch (e) { return reply(400, { error: e.message }); }
    waiting.push({ who: w, run: async () => {
      begin();
      current = { task: name, since: Date.now(), who: w };
      let timer;
      try {
        const ms = LIMITS[name] || TASK_LIMIT;
        const limit = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`task ${name} took over ${ms / 60e3} minutes`)), ms); });
        reply(200, await Promise.race([tasks[name](body), limit]));
      } catch (e) {
        console.error(`[${w.person}] ${name}`, e?.stack || e?.message || e);
        session.workerError(`task ${name}`, e, { job: body.job?.id || null, url: session.livePage?.url?.() || null });
        reply(500, { error: e?.message || String(e) });
      }
      finally {
        clearTimeout(timer); end(); current = null;
        try { writeFileSync(join(w.data, 'live.json'), JSON.stringify({ task: null, url: null, at: Date.now() })); } catch {}
      }
    } });
    pump();
  });
}).listen(8084, '127.0.0.1', () => console.log('browser worker on 127.0.0.1:8084'));
