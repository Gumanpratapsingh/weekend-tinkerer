// Shared browser + per-site login sessions for the worker and its site modules.
import { createRequire } from 'node:module';
import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire('/opt/pw/')('playwright');
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SESSIONS = join(ROOT, 'data', 'sessions');
mkdirSync(SESSIONS, { recursive: true });

let browser;
export async function getBrowser() {
  if (browser?.isConnected()) return browser;
  browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled', '--window-size=1366,900'],
  });
  return browser;
}

// A context per site, carrying that site's saved login (data/sessions/<site>.json, made on the Mac).
export async function siteContext(site) {
  const b = await getBrowser();
  const state = join(SESSIONS, `${site}.json`);
  const ctx = await b.newContext({
    storageState: existsSync(state) ? state : undefined,
    viewport: { width: 1366, height: 900 }, locale: 'en-IN', timezoneId: 'Asia/Kolkata',
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  });
  ctx.saveSession = () => ctx.storageState({ path: state });
  return ctx;
}
export const shotPath = (name) => join(ROOT, 'data', 'shots', `${new Date().toISOString().replace(/[:.]/g, '-')}-${name}.png`);

