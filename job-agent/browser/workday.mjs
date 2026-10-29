// Workday applicant portal handler: account creation, sign-in, email verification, and multi-step wizard.
// Handles *.myworkdayjobs.com, *.myworkdaysite.com, and company-branded Workday domains.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { siteContext, progress, capture, who } from './session.mjs';
import { fillForm, captchaVisible } from './forms.mjs';
import { solveCaptcha, solverConfigured } from './captcha-solver.mjs';

const DONE = /thank you for (applying|your (application|interest))|application (has been )?(submitted|received)|congratulations|we('ve| have) received your application|successfully submitted|your application was submitted/i;
const DEFAULT_PASS = 'CandidatePass2026!#';

export function isWorkday(url) {
  return /myworkdayjobs\.com|myworkdaysite\.com|\.workday\.com/i.test(String(url || ''));
}

export function workdayTenant(url) {
  try {
    const host = new URL(url).hostname;
    const m = /^([a-z0-9-]+)\.(wd\d+)\.(myworkdayjobs|myworkdaysite)\.com/i.exec(host);
    if (m) return `${m[1]}.${m[2]}`;
    return host;
  } catch {
    return 'workday';
  }
}

function getAccounts() {
  const f = join(who().data, 'accounts.json');
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return {}; }
}

function saveAccount(tenant, email, password) {
  const f = join(who().data, 'accounts.json');
  const accs = getAccounts();
  accs[tenant] = { email, password, updated_at: Date.now() };
  try { writeFileSync(f, JSON.stringify(accs, null, 2)); } catch {}
}

function getCandidateEmail() {
  try {
    const dir = who().data;
    const profDir = dir.endsWith('/data') ? join(dir, '..', 'profile') : join(ROOT, 'profile');
    for (const f of [join(profDir, 'private.json'), join(profDir, 'master.json'), join(ROOT, 'profile', 'private.json')]) {
      if (existsSync(f)) {
        const j = JSON.parse(readFileSync(f, 'utf8'));
        const em = j.mailbox || j.email || j.persona?.email || j.contact?.email;
        if (em && /@/.test(em)) return em;
      }
    }
  } catch {}
  return 'gumanpratapsinghparmar@gmail.com';
}

async function fetchVerificationCode(agentUrl, tenant) {
  progress('Workday: waiting for email verification code…');
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 4000));
    try {
      const res = await fetch(`${agentUrl}/internal/security-code?company=${encodeURIComponent(tenant || 'Workday')}`, {
        signal: AbortSignal.timeout(5000),
      });
      const data = await res.json();
      if (data?.code) {
        progress(`Workday: received verification code ${data.code}`);
        return data.code;
      }
    } catch {}
  }
  return null;
}

export async function applyWorkday({ job, resume, dryRun = false, keepOpen = false }) {
  const tenant = workdayTenant(job.apply_url);
  progress(`Workday [${tenant}]: opening ${job.title} @ ${job.company}`);
  const ctx = await siteContext('workday');
  let page = await ctx.newPage();
  const snap = (name) => capture(page, name);

  try {
    await page.goto(job.apply_url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);

    if (/no longer (accepting|available)|job (has been )?closed|position has been filled/i.test(await page.innerText('body').catch(() => ''))) {
      return { status: 'closed' };
    }

    // 1. Wait for and click the main Apply button
    const applySel = '[data-automation-id="adventureButton"], [data-automation-id="applyButton"], a:has-text("Apply"), button:has-text("Apply")';
    await page.waitForSelector(applySel, { timeout: 15000 }).catch(() => {});
    const applyBtn = page.locator(applySel).first();
    if (await applyBtn.isVisible().catch(() => false)) {
      progress(`Workday [${tenant}]: clicking Apply button`);
      await applyBtn.click({ timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(2500);
    }

    // 2. Wait for modal options (Apply Manually or Autofill with Resume)
    const manualSel = '[data-automation-id="applyManually"], a:has-text("Apply Manually"), button:has-text("Apply Manually"), [data-automation-id="autofillWithResume"], a:has-text("Autofill with Resume")';
    await page.waitForSelector(manualSel, { timeout: 8000 }).catch(() => {});
    const manualBtn = page.locator(manualSel).first();
    if (await manualBtn.isVisible().catch(() => false)) {
      progress(`Workday [${tenant}]: choosing application mode`);
      await manualBtn.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(3500);
    }

    // 3. Wait for client-side React to load Account / Sign In inputs
    const authInputSel = 'input[data-automation-id="email"], input[data-automation-id="password"]';
    await page.waitForSelector(authInputSel, { timeout: 20000 }).catch(() => {});

    const emailInput = page.locator('input[data-automation-id="email"]').first();
    const passInput = page.locator('input[data-automation-id="password"]').first();
    const verifyPass = page.locator('input[data-automation-id="verifyPassword"]').first();

    if (await emailInput.isVisible().catch(() => false) && await passInput.isVisible().catch(() => false)) {
      const isCreateAccount = await verifyPass.isVisible().catch(() => false);
      const accounts = getAccounts();
      const existing = accounts[tenant];
      const agentUrl = who().agent;
      const candidateEmail = existing?.email || getCandidateEmail();
      const password = existing?.password || DEFAULT_PASS;

      if (!isCreateAccount && existing) {
        progress(`Workday [${tenant}]: signing in with existing account`);
        await emailInput.fill(candidateEmail).catch(() => {});
        await passInput.fill(password).catch(() => {});
        const submitSignIn = page.locator('button[data-automation-id="signInSubmitButton"], button:has-text("Sign In")').first();
        await submitSignIn.click({ timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(4000);
      } else {
        // If on Sign In screen but no account yet, click Create Account tab/link
        if (!isCreateAccount) {
          const createAccountLink = page.locator('button[data-automation-id="createAccountLink"], a[data-automation-id="createAccountLink"], button:has-text("Create Account"), a:has-text("Create Account")').first();
          if (await createAccountLink.isVisible().catch(() => false)) {
            await createAccountLink.click({ timeout: 6000 }).catch(() => {});
            await page.waitForTimeout(3000);
          }
        }

        progress(`Workday [${tenant}]: creating new candidate account (${candidateEmail})`);
        await emailInput.fill(candidateEmail).catch(() => {});
        await passInput.fill(password).catch(() => {});
        if (await verifyPass.isVisible().catch(() => false)) {
          await verifyPass.fill(password).catch(() => {});
        }

        // Terms checkbox
        const agreeCheckbox = page.locator('input[data-automation-id="createAccountCheckbox"], input[type="checkbox"]').first();
        if (await agreeCheckbox.isVisible().catch(() => false)) {
          await agreeCheckbox.check().catch(() => agreeCheckbox.click().catch(() => {}));
        }

        saveAccount(tenant, candidateEmail, password);

        const submitCreate = page.locator('button[data-automation-id="createAccountSubmitButton"], button:has-text("Create Account")').first();
        await submitCreate.click({ timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(5000);

        // Check if email verification code was requested
        const codeInput = page.locator('input[data-automation-id="verificationCode"], input[name*="code" i]').first();
        if (await codeInput.isVisible().catch(() => false) || /verification code|security code/i.test(await page.innerText('body').catch(() => ''))) {
          const code = await fetchVerificationCode(agentUrl, tenant);
          if (code && await codeInput.isVisible().catch(() => false)) {
            await codeInput.fill(code);
            const verifyBtn = page.locator('button[data-automation-id="submit-button"], button:has-text("Submit"), button:has-text("Verify")').first();
            await verifyBtn.click({ timeout: 8000 }).catch(() => {});
            await page.waitForTimeout(4000);
          }
        }
      }
    }

    // 4. Stepper Wizard loop (up to 7 steps). sent: every step's answers as read back from the page, for "what I sent".
    const sent = []; let sentShot = null;
    for (let step = 1; step <= 7; step++) {
      await page.waitForTimeout(3000);

      // Check CAPTCHA
      if (await captchaVisible(page)) {
        if (solverConfigured()) {
          progress(`Workday [${tenant}]: attempting auto-solve CAPTCHA on step ${step}`);
          const solveRes = await solveCaptcha(page);
          if (!solveRes.solved) {
            return { status: 'manual', reason: 'captcha', shot: await snap('wd-captcha') };
          }
        } else {
          return { status: 'manual', reason: 'captcha', shot: await snap('wd-captcha') };
        }
      }

      const bodyText = await page.innerText('body').catch(() => '');
      if (DONE.test(bodyText) || /thank|success|confirm/i.test(page.url())) {
        return { status: 'applied', shot: await snap('wd-done') };
      }

      progress(`Workday [${tenant}]: filling application wizard step ${step}…`);
      const res = await fillForm(page, job, { root: null, resume, dryRun: dryRun || keepOpen, partial: keepOpen });
      if (keepOpen) return { ...res, status: 'handoff', page };
      if (res.status === 'needs_answer') return { ...res, shot: await snap(`wd-step${step}-question`) };
      // Anything but a clean fill (the read-back found a field that didn't stick, an odd field): stop before Next/Submit.
      if (!['filled', 'dry_run'].includes(res.status)) return { ...res, filled: [...sent, ...(res.filled || [])], shot: await snap(`wd-step${step}-check`) };
      sent.push(...(res.filled || []));

      // Look for next or submit button
      const nextSel = 'button[data-automation-id="bottom-navigation-next-button"], button:has-text("Save and Continue"), button:has-text("Next"), button[data-automation-id="submit-button"], button:has-text("Submit")';
      await page.waitForSelector(nextSel, { timeout: 15000 }).catch(() => {});
      const nextBtn = page.locator(nextSel).first();
      if (!await nextBtn.isVisible().catch(() => false)) {
        break; // Reached end or unable to find navigation button
      }

      const btnText = (await nextBtn.innerText().catch(() => '')).toLowerCase();
      const isFinalSubmit = /submit/i.test(btnText) || step >= 5;

      if (isFinalSubmit && dryRun) {
        return { status: 'dry_run', shot: await snap('wd-dry') };
      }

      if (isFinalSubmit) sentShot = await snap('wd-sent');
      progress(`Workday [${tenant}]: advancing (${btnText || 'Next'})`);
      await nextBtn.scrollIntoViewIfNeeded().catch(() => {});
      await nextBtn.click({ timeout: 10000 }).catch(() => nextBtn.click({ force: true }).catch(() => {}));
      await page.waitForTimeout(4500);

      const afterText = await page.innerText('body').catch(() => '');
      if (DONE.test(afterText) || /thank|success|confirm/i.test(page.url())) {
        return { status: 'applied', shot: await snap('wd-done'), filled: sent, sent_shot: sentShot };
      }
    }

    const finalBody = await page.innerText('body').catch(() => '');
    if (DONE.test(finalBody) || /thank|success|confirm/i.test(page.url())) {
      return { status: 'applied', shot: await snap('wd-done'), filled: sent, sent_shot: sentShot };
    }

    return { status: 'manual', reason: 'wizard completed without final confirmation', shot: await snap('wd-finish') };
  } finally {
    if (!keepOpen) await ctx.close().catch(() => {});
  }
}

export default {
  apply_workday: (b) => applyWorkday(b),
};
