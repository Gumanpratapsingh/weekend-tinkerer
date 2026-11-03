// Workday applicant portal handler: Apply button, account wall check, and multi-step wizard.
// Never creates accounts, signs in or reads emailed codes: an account wall goes to the person.
// Handles *.myworkdayjobs.com, *.myworkdaysite.com, and company-branded Workday domains.
import { siteContext, progress, capture } from './session.mjs';
import { fillForm, captchaVisible } from './forms.mjs';
import { solveCaptcha, solverConfigured } from './captcha-solver.mjs';

const DONE = /thank you for (applying|your (application|interest))|application (has been )?(submitted|received)|congratulations|we('ve| have) received your application|successfully submitted|your application was submitted/i;
// Workday's page for a removed posting; it used to end as "wizard completed without final confirmation" (2026-11-02).
const GONE = /no longer (accepting|available)|job (has been )?closed|position has been filled|page you are looking for doesn.t exist/i;

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

export async function applyWorkday({ job, resume, dryRun = false, keepOpen = false }) {
  const tenant = workdayTenant(job.apply_url);
  progress(`Workday [${tenant}]: opening ${job.title} @ ${job.company}`);
  const ctx = await siteContext('workday');
  let page = await ctx.newPage();
  const snap = (name) => capture(page, name);

  try {
    await page.goto(job.apply_url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);

    if (GONE.test(await page.innerText('body').catch(() => ''))) {
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

    // A Create Account / Sign In page: only the person can do this one, and it ends here before the wizard.
    if (await page.locator(authInputSel).first().isVisible().catch(() => false)) {
      return { status: 'manual', reason: `needs an account on ${new URL(page.url()).hostname}`, shot: await snap('wd-account') };
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

    if (GONE.test(finalBody)) return { status: 'closed' };
    return { status: 'manual', reason: 'wizard completed without final confirmation', shot: await snap('wd-finish') };
  } finally {
    if (!keepOpen) await ctx.close().catch(() => {});
  }
}

export default {
  apply_workday: (b) => applyWorkday(b),
};
