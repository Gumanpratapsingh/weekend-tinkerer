// Wellfound: apply with the person's own Wellfound session (data/sessions/wellfound.json). "?autoOpenApplication=true" opens the
// apply box: a note to the company ("What interests you about working for this company?") plus any custom questions, then
// "Send application". The resume is the one on the person's Wellfound profile.
import { siteContext, progress, capture } from './session.mjs';
import { collect, resolveFields, fill, verifyFilled, captchaVisible } from './forms.mjs';

const DIALOG = '[role="dialog"]';
const SUBMIT = '[data-test="JobApplicationModal--SubmitButton"], button[type="submit"]:has-text("Send application")';

async function applyWellfound({ job, resume, dryRun = false }) {
  progress(`Wellfound: opening ${job.title} @ ${job.company}`);
  const ctx = await siteContext('wellfound');
  const page = await ctx.newPage();
  const snap = (name) => capture(page, name);
  let signedIn = false;
  try {
    await page.goto(`${job.apply_url.split('?')[0]}?autoOpenApplication=true`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const box = page.locator(`${DIALOG}:has(form)`).first();
    await box.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    if (/\/login|\/jobs\/signup/.test(page.url()) || await page.locator('button:has-text("Log In"):visible').count()) return { status: 'session_expired' };
    signedIn = true;
    if (await captchaVisible(page)) return { status: 'manual', reason: 'captcha', shot: await snap('wf-captcha') };
    const body = await page.innerText('body').catch(() => '');
    if (/\b404\b[\s\S]{0,80}couldn.t find|no longer (accepting|available)|job (is )?(closed|expired)/i.test(body)) return { status: 'closed' };
    if (!await box.count()) {
      // Already sent from this account: the job page shows Applied instead of opening the box.
      if (await page.locator('button:visible, a:visible').filter({ hasText: /^\s*applied\s*$/i }).count()) return { status: 'already_applied' };
      return { status: 'manual', reason: 'Wellfound apply box did not open', shot: await snap('wf-nobox') };
    }

    // Only the box's own fields: the page behind it has a search box and filters.
    const root = `${DIALOG} form`;
    const fields = (await collect(page, root)).filter((f) => f.type !== 'password');
    if (!fields.length) return { status: 'manual', reason: 'Wellfound apply box has no questions to read', shot: await snap('wf-empty') };
    const { answers, unknown } = await resolveFields(fields, job);
    if (unknown.length) return { status: 'needs_answer', unknown, shot: await snap('wf-question') };
    progress(`Wellfound: ${fields.map((f) => `"${f.label.slice(0, 50)}" = ${String(answers[f.key] ?? '(prefilled)').slice(0, 60)}`).join(' · ')}`);
    await fill(page, fields, answers, { resume });
    // Read the box back before sending: an answer the page dropped or changed must never go out.
    const check = await verifyFilled(page, fields, answers, { resume });
    if (check.reason) return { status: 'manual', reason: check.reason, filled: check.sent, shot: await snap('wf-check') };
    const sentShot = await snap(dryRun ? 'wf-dry' : 'wf-sent');
    if (dryRun) return { status: 'dry_run', shot: sentShot, filled: check.sent };

    await box.locator(SUBMIT).first().click({ timeout: 10000 });
    await page.waitForTimeout(6000);
    if (await captchaVisible(page)) return { status: 'manual', reason: 'captcha', shot: await snap('wf-captcha') };
    if (await box.isVisible().catch(() => false)) {
      const errors = await box.locator('[class*="error" i]:visible, [aria-invalid="true"]').allInnerTexts().catch(() => []);
      return { status: 'failed', reason: errors.filter(Boolean).slice(0, 4).join(' | ') || 'apply box still open after Send', shot: await snap('wf-stuck'), filled: check.sent };
    }
    const done = /application (was )?(sent|submitted)|you applied|\bapplied\b/i.test(await page.innerText('body').catch(() => ''));
    // Sent may have gone through without a visible confirmation: never press it again (that could apply twice).
    return done ? { status: 'applied', shot: await snap('wf-done'), filled: check.sent, sent_shot: sentShot }
      : { status: 'failed', reason: 'no confirmation seen', shot: await snap('wf-unsure'), filled: check.sent };
  } finally { if (signedIn) await ctx.saveSession().catch(() => {}); await ctx.close(); }
}

export default { apply_wellfound: applyWellfound };
