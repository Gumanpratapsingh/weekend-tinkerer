// Shared browser + per-site login sessions for the worker and its site modules.
import { createRequire } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { totalmem } from 'node:os';

const { chromium } = createRequire(process.env.PW_DIR || '/opt/pw/')('playwright');
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Whose task is running: {person, data, agent}. The worker runs each task inside person.run(...); outside a task (or on
// the Mac handoff) it is the owner: data/ in this repo and the agent at AGENT_URL / :8083.
export const person = new AsyncLocalStorage();
const OWNER = { person: 'owner', data: join(ROOT, 'data'), agent: process.env.AGENT_URL || 'http://127.0.0.1:8083' };
export const who = () => person.getStore() || OWNER;
const sessions = () => { const d = join(who().data, 'sessions'); mkdirSync(d, { recursive: true }); return d; };

// One Chromium per PERSON on a big machine (the laptop): a crash, a restart or the idle close of one person's browser never
// touches the other's tasks, and the LinkedIn lookups of one person share only that person's browser. The phone (small RAM)
// keeps one shared browser. JA_BROWSER_PER_PERSON=0/1 overrides.
const PER_PERSON = process.env.JA_BROWSER_PER_PERSON ? process.env.JA_BROWSER_PER_PERSON !== '0' : totalmem() > 12e9;
const slots = new Map();                              // person (or 'shared') -> { browser, launching, idleTimer, busy }
const slot = () => { const k = PER_PERSON ? who().person : 'shared'; if (!slots.has(k)) slots.set(k, { browser: null, launching: null, idleTimer: null, busy: 0 }); return slots.get(k); };
// Close a browser after 4 idle minutes so it is not holding memory and processes between tasks.
export function begin() { const s = slot(); s.busy++; clearTimeout(s.idleTimer); }   // tasks in progress: never close the browser under them
export function end() { const s = slot(); s.busy = Math.max(0, s.busy - 1); touch(); }
export function touch() {
  const s = slot();
  clearTimeout(s.idleTimer);
  if (s.busy) return;
  if (process.env.KEEP_BROWSER) return;               // Mac handoff: the owner is using the window
  s.idleTimer = setTimeout(async () => { const x = s.browser; s.browser = null; await x?.close().catch(() => {}); }, 4 * 60e3);
}
export async function closeBrowser() { for (const s of slots.values()) { clearTimeout(s.idleTimer); const x = s.browser; s.browser = null; await x?.close().catch(() => {}); } }
export const browserCount = () => [...slots.values()].filter((s) => s.browser?.isConnected()).length;
const LAUNCH = () => chromium.launch({
    headless: false,
    // Few processes: Android 13's phantom-process killer stops Termux when its children pass 32.
    args: ['--no-sandbox', '--no-zygote', '--disable-gpu', '--renderer-process-limit=1', '--disable-features=site-per-process,Translate,MediaRouter',
      '--disable-extensions', '--disable-background-networking', '--disable-component-update', '--mute-audio',
      '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled', '--window-size=1366,900'],
  });
export async function getBrowser() {
  touch();
  const s = slot();
  if (s.browser?.isConnected()) return s.browser;
  // Two tasks of one person asking at once (the LinkedIn lane) must not each launch a browser.
  s.launching ||= LAUNCH().then((x) => { s.browser = x; return x; }).finally(() => { s.launching = null; });
  return s.launching;
}
// A short-lived second browser for a live sign-in, so the person doesn't wait behind a long search. Closed when done.
export const launchSeparate = () => LAUNCH();

// A context per site, carrying that site's saved login (data/sessions/<site>.json, made on the Mac).
export async function siteContext(site, { images = false, viewport = { width: 1366, height: 900 }, browser: own = null } = {}) {
  const b = own || await getBrowser();
  const SESSIONS = sessions();
  const state = join(SESSIONS, `${site}.json`);
  const ctx = await b.newContext({
    storageState: existsSync(state) ? state : undefined,
    viewport, locale: 'en-IN', timezoneId: 'Asia/Kolkata',
    // Same browser identity the session was created with (saved by scripts/login.sh), else a desktop Linux Chrome.
    userAgent: existsSync(join(SESSIONS, `${site}.ua`)) ? readFileSync(join(SESSIONS, `${site}.ua`), 'utf8').trim()
      : 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  });
  ctx.saveSession = async () => {
    await ctx.storageState({ path: state });
    if (!existsSync(join(SESSIONS, `${site}.ua`))) writeFileSync(join(SESSIONS, `${site}.ua`), await ctx.pages()[0]?.evaluate(() => navigator.userAgent).catch(() => '') || '');
  };
  // Phone only: skip images and video. Much less CPU/heat; application forms don't need them.
  if (!process.env.KEEP_BROWSER && !images) await ctx.route('**/*', (r) => (['image', 'media'].includes(r.request().resourceType()) ? r.abort() : r.continue()));
  if (!own) watch(ctx);                                 // the live screen follows queued tasks only
  return ctx;
}

// Live screen for the hub: the page each person's agent is working in right now (people's tasks can run in parallel).
const livePages = new Map();                          // person -> page
export const livePageOf = (person) => livePages.get(person) || null;
export function watch(ctx) {
  const person = who().person;
  const track = (p) => { livePages.set(person, p); p.on('close', () => { if (livePages.get(person) === p) livePages.delete(person); }); };
  ctx.pages().forEach(track);
  ctx.on('page', track);
}
import { appendFileSync } from 'node:fs';
export function progress(text) {                      // shows up live on the hub's /jobs/live page
  try { appendFileSync(join(who().data, 'activity.log'), `${new Date().toISOString()} 📱 Phone browser: ${String(text).replace(/\s*\n\s*/g, ' ⏎ ').slice(0, 400)}\n`); } catch { /* best effort */ }
}
// Evidence for a failure: screenshot + the page's HTML + URL, side by side (same name, .png / .html).
export async function capture(page, name, { fullPage = true } = {}) {
  const png = shotPath(name);
  await page.screenshot({ path: png, fullPage }).catch(() => {});
  try { const { writeFileSync } = await import('node:fs');
    writeFileSync(png.replace(/\.png$/, '.html'), `<!-- ${page.url()} -->\n${await page.content()}`); } catch { /* page gone */ }
  return png;
}
export function workerError(kind, err, ctx = {}) {
  const row = { at: new Date().toISOString(), src: 'browser', kind, message: String(err?.message || err).slice(0, 600), stack: String(err?.stack || '').slice(0, 2000), ctx };
  try { appendFileSync(join(who().data, 'errors.jsonl'), JSON.stringify(row) + '\n'); } catch { /* best effort */ }
}
export const shotPath = (name) => join(who().data, 'shots', `${new Date().toISOString().replace(/[:.]/g, '-')}-${name}.png`);

