// Automated CAPTCHA solver using CapSolver or 2Captcha API.
// Solves Cloudflare Turnstile, Google reCAPTCHA v2/v3, and hCaptcha.
// Secrets: ~/.jobagent/capsolver_key or ~/.jobagent/twocaptcha_key (set via ./scripts/set-secret.sh)
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const HOME = homedir();
function getSecret(name) {
  if (process.env[name.toUpperCase()]) return process.env[name.toUpperCase()];
  const f = join(HOME, '.jobagent', name);
  return existsSync(f) ? readFileSync(f, 'utf8').trim() : '';
}

export function solverConfigured() {
  return !!(getSecret('capsolver_key') || getSecret('twocaptcha_key'));
}

export async function detectCaptcha(page) {
  const url = page.url();
  // Check frames
  for (const fr of page.frames()) {
    const fUrl = fr.url();
    if (/challenges\.cloudflare\.com/.test(fUrl)) {
      const sitekey = await fr.evaluate(() => {
        const u = new URL(location.href);
        return u.searchParams.get('k') || u.searchParams.get('sitekey');
      }).catch(() => null) || await page.evaluate(() => {
        const el = document.querySelector('.cf-turnstile, [data-sitekey]');
        return el ? el.getAttribute('data-sitekey') : null;
      }).catch(() => null);
      if (sitekey) return { type: 'turnstile', sitekey, pageUrl: url };
    }
    if (/recaptcha\/api2\/(bframe|anchor)/.test(fUrl)) {
      const sitekey = await fr.evaluate(() => {
        const u = new URL(location.href);
        return u.searchParams.get('k');
      }).catch(() => null) || await page.evaluate(() => {
        const el = document.querySelector('.g-recaptcha, [data-sitekey]');
        return el ? el.getAttribute('data-sitekey') : null;
      }).catch(() => null);
      if (sitekey) return { type: 'recaptcha', sitekey, pageUrl: url };
    }
    if (/hcaptcha\.com/.test(fUrl)) {
      const sitekey = await fr.evaluate(() => {
        const u = new URL(location.href);
        return u.searchParams.get('sitekey') || u.searchParams.get('k');
      }).catch(() => null) || await page.evaluate(() => {
        const el = document.querySelector('.h-captcha, [data-sitekey]');
        return el ? el.getAttribute('data-sitekey') : null;
      }).catch(() => null);
      if (sitekey) return { type: 'hcaptcha', sitekey, pageUrl: url };
    }
  }

  // Check DOM directly in main frame
  return page.evaluate(() => {
    const cf = document.querySelector('.cf-turnstile, [data-sitekey]');
    if (cf && cf.getAttribute('data-sitekey') && document.querySelector('iframe[src*="cloudflare"]')) {
      return { type: 'turnstile', sitekey: cf.getAttribute('data-sitekey'), pageUrl: location.href };
    }
    const rc = document.querySelector('.g-recaptcha, [data-sitekey]');
    if (rc && rc.getAttribute('data-sitekey') && document.querySelector('iframe[src*="recaptcha"]')) {
      return { type: 'recaptcha', sitekey: rc.getAttribute('data-sitekey'), pageUrl: location.href };
    }
    const hc = document.querySelector('.h-captcha, [data-sitekey]');
    if (hc && hc.getAttribute('data-sitekey') && document.querySelector('iframe[src*="hcaptcha"]')) {
      return { type: 'hcaptcha', sitekey: hc.getAttribute('data-sitekey'), pageUrl: location.href };
    }
    return null;
  }).catch(() => null);
}

async function solveWithCapSolver(apiKey, { type, sitekey, pageUrl }) {
  const typeMap = {
    turnstile: 'AntiTurnstileTaskProxyLess',
    recaptcha: 'ReCaptchaV2TaskProxyLess',
    hcaptcha: 'HCaptchaTaskProxyLess',
  };
  const taskType = typeMap[type];
  if (!taskType) throw new Error(`unsupported captcha type ${type}`);

  const createRes = await fetch('https://api.capsolver.com/createTask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientKey: apiKey,
      task: { type: taskType, websiteURL: pageUrl, websiteKey: sitekey },
    }),
    signal: AbortSignal.timeout(15000),
  }).then((r) => r.json());

  if (createRes.errorId > 0) throw new Error(`capsolver createTask: ${createRes.errorDescription || createRes.errorCode}`);
  const taskId = createRes.taskId;

  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const resultRes = await fetch('https://api.capsolver.com/getTaskResult', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: apiKey, taskId }),
      signal: AbortSignal.timeout(15000),
    }).then((r) => r.json());

    if (resultRes.status === 'ready') {
      return resultRes.solution.token || resultRes.solution.gRecaptchaResponse;
    }
    if (resultRes.status === 'failed' || resultRes.errorId > 0) {
      throw new Error(`capsolver failed: ${resultRes.errorDescription || 'unknown'}`);
    }
  }
  throw new Error('capsolver timeout after 60s');
}

async function solveWith2Captcha(apiKey, { type, sitekey, pageUrl }) {
  const typeMap = {
    turnstile: 'TurnstileTaskProxyless',
    recaptcha: 'RecaptchaV2TaskProxyless',
    hcaptcha: 'HCaptchaTaskProxyless',
  };
  const taskType = typeMap[type];
  if (!taskType) throw new Error(`unsupported captcha type ${type}`);

  const createRes = await fetch('https://api.2captcha.com/createTask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientKey: apiKey,
      task: { type: taskType, websiteURL: pageUrl, websiteKey: sitekey },
    }),
    signal: AbortSignal.timeout(15000),
  }).then((r) => r.json());

  if (createRes.errorId > 0) throw new Error(`2captcha createTask: ${createRes.errorDescription || createRes.errorCode}`);
  const taskId = createRes.taskId;

  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const resultRes = await fetch('https://api.2captcha.com/getTaskResult', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: apiKey, taskId }),
      signal: AbortSignal.timeout(15000),
    }).then((r) => r.json());

    if (resultRes.status === 'ready') {
      return resultRes.solution.token || resultRes.solution.gRecaptchaResponse;
    }
    if (resultRes.status === 'failed' || resultRes.errorId > 0) {
      throw new Error(`2captcha failed: ${resultRes.errorDescription || 'unknown'}`);
    }
  }
  throw new Error('2captcha timeout after 75s');
}

export async function solveCaptcha(page) {
  const detected = await detectCaptcha(page);
  if (!detected) return { solved: false, reason: 'no recognizable captcha detected' };

  const capsolver = getSecret('capsolver_key');
  const twocaptcha = getSecret('twocaptcha_key');
  if (!capsolver && !twocaptcha) {
    return { solved: false, reason: 'no capsolver_key or twocaptcha_key configured in ~/.jobagent' };
  }

  let token = null;
  try {
    if (capsolver) token = await solveWithCapSolver(capsolver, detected);
    else if (twocaptcha) token = await solveWith2Captcha(twocaptcha, detected);
  } catch (e) {
    return { solved: false, reason: e.message };
  }

  if (!token) return { solved: false, reason: 'no token returned' };

  // Inject token into page
  await page.evaluate(({ type, token }) => {
    if (type === 'turnstile') {
      const el = document.querySelector('[name="cf-turnstile-response"]') || document.querySelector('input[name*="turnstile"]');
      if (el) { el.value = token; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
      if (typeof window.turnstile?.callback === 'function') window.turnstile.callback(token);
    } else if (type === 'recaptcha') {
      const el = document.querySelector('[name="g-recaptcha-response"]') || document.getElementById('g-recaptcha-response');
      if (el) { el.value = token; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
      if (window.___grecaptcha_cfg?.clients) {
        for (const c of Object.values(window.___grecaptcha_cfg.clients)) {
          for (const v of Object.values(c || {})) {
            if (v && typeof v.callback === 'function') v.callback(token);
          }
        }
      }
    } else if (type === 'hcaptcha') {
      const el = document.querySelector('[name="h-captcha-response"]') || document.querySelector('[name="g-recaptcha-response"]');
      if (el) { el.value = token; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
      if (typeof window.hcaptcha?.callback === 'function') window.hcaptcha.callback(token);
    }
  }, { type: detected.type, token }).catch(() => {});

  await page.waitForTimeout(2000);
  return { solved: true, type: detected.type, token };
}
