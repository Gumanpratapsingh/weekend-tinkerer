// LinkedIn Easy Apply with the owner's session (data/sessions/linkedin.json, saved by scripts/login.sh on the Mac).
// Steps through the modal: upload the tailored resume, answer fields from memory, Next/Review/Submit.
import { siteContext, shotPath, progress } from './session.mjs';
import { collect, resolveFields, fill, captchaVisible } from './forms.mjs';

const MODAL = '.jobs-easy-apply-modal, [data-test-modal-id="easy-apply-modal"], div[role="dialog"]';

export default {
  async apply_linkedin({ job, resume, dryRun = false }) {
    progress(`LinkedIn: Easy Apply to ${job.title} @ ${job.company}`);
    const ctx = await siteContext('linkedin');
    const page = await ctx.newPage();
    try {
      await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(4000 + Math.random() * 2000);
      if (/\/(login|authwall|checkpoint)/.test(page.url()) || await page.locator('a:has-text("Sign in"), button:has-text("Sign in")').first().isVisible().catch(() => false))
        return { status: 'session_expired' };
      if (await page.locator('.artdeco-inline-feedback:has-text("Applied"), span:has-text("Applied on")').count()) return { status: 'already_applied' };
      if (/no longer accepting applications/i.test(await page.innerText('main').catch(() => ''))) return { status: 'closed' };

      const btn = page.locator('button.jobs-apply-button, button:has-text("Easy Apply")').first();
      if (!await btn.count()) return { status: 'manual', reason: 'not Easy Apply' };
      if (!/easy apply/i.test(await btn.innerText())) return { status: 'manual', reason: 'applies on company site' };
      await btn.click();
      await page.waitForSelector(MODAL, { timeout: 15000 });

      let lastStep = '';
      for (let step = 0; step < 15; step++) {
        await page.waitForTimeout(1500 + Math.random() * 1000);
        if (await captchaVisible(page)) return await discard(page, { status: 'manual', reason: 'captcha' });
        const modal = page.locator(MODAL).first();

        // Resume step: upload this job's tailored PDF.
        const upload = modal.locator('input[type="file"]').first();
        if (resume && await upload.count()) { await upload.setInputFiles(resume); await page.waitForTimeout(3000); }

        const fields = (await collect(page, MODAL)).filter((f) => f.type !== 'file');
        progress(`LinkedIn: step ${step + 1}, ${fields.length} field(s)`);
        const { answers, unknown } = await resolveFields(fields, job);
        const blocking = unknown.filter((u) => u.required || /required/i.test(u.label));
        if (blocking.length) return await discard(page, { status: 'needs_answer', unknown: blocking, shot: await snap(page, 'li-question') });
        await fill(page, fields, answers, {});

        const follow = modal.locator('input#follow-company-checkbox');
        if (await follow.count() && await follow.isChecked()) await follow.uncheck({ force: true }).catch(() => {});

        const submit = modal.locator('button[aria-label="Submit application"], button:has-text("Submit application")');
        if (await submit.count()) {
          if (dryRun) return await discard(page, { status: 'dry_run', shot: await snap(page, 'li-dry') });
          await submit.first().click();
          await page.waitForTimeout(5000);
          const ok = await page.locator(':text("application was sent"), :text("Application submitted"), h3:has-text("Your application was sent")').count();
          const shot = await snap(page, ok ? 'li-done' : 'li-unsure');
          await page.locator('button[aria-label="Dismiss"]').first().click().catch(() => {});
          return ok ? { status: 'applied', shot } : { status: 'failed', reason: 'no confirmation seen', shot };
        }
        const next = modal.locator('button[aria-label="Continue to next step"], button[aria-label="Review your application"], button:has-text("Next"), button:has-text("Review")').first();
        if (!await next.count()) return await discard(page, { status: 'failed', reason: 'no next button', shot: await snap(page, 'li-stuck') });
        const stepText = (await modal.innerText()).slice(0, 400);
        if (stepText === lastStep) {
          const errs = await modal.locator('.artdeco-inline-feedback--error').allInnerTexts();
          return await discard(page, { status: 'failed', reason: `stuck: ${errs.join(' | ').slice(0, 200)}`, shot: await snap(page, 'li-stuck') });
        }
        lastStep = stepText;
        await next.click();
      }
      return await discard(page, { status: 'failed', reason: 'too many steps' });
    } finally { await ctx.saveSession().catch(() => {}); await ctx.close(); }
  },
};

async function discard(page, result) {
  await page.locator('button[aria-label="Dismiss"]').first().click({ timeout: 3000 }).catch(() => {});
  await page.locator('button[data-control-name="discard_application_confirm_btn"], button:has-text("Discard")').first().click({ timeout: 3000 }).catch(() => {});
  return result;
}
const snap = async (page, name) => { const p = shotPath(name); await page.screenshot({ path: p }); return p; };
