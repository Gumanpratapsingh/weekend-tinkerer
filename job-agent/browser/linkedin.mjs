// LinkedIn Easy Apply with the owner's session (data/sessions/linkedin.json, saved by scripts/login.sh on the Mac).
// Steps through the modal: upload the tailored resume, answer fields from memory, Next/Review/Submit.
import { siteContext, shotPath, progress } from './session.mjs';
import { collect, resolveFields, fill, captchaVisible } from './forms.mjs';

// Easy Apply is a pop-up on the old UI and an in-page panel ("Apply to X · 1/5 pages") on the new one.
// markRoot() tags whichever container holds the form so every step can be scoped to it.
const MODAL = '[data-ja-root="1"]';
async function markRoot(page) {
  return page.evaluate(() => {
    document.querySelectorAll('[data-ja-root]').forEach((e) => e.removeAttribute('data-ja-root'));
    const old = document.querySelector('.jobs-easy-apply-modal, [data-test-modal-id="easy-apply-modal"], div[role="dialog"]');
    let el = old;
    if (!el) {
      const head = [...document.querySelectorAll('h1, h2, h3, span, div')].find((n) => /^Apply to\s/.test(n.textContent.trim()) && n.textContent.trim().length < 120);
      el = head;
      while (el && !(el.querySelector('input, select, textarea') && [...el.querySelectorAll('button')].some((b) => /next|review|submit/i.test(b.textContent)))) el = el.parentElement;
    }
    if (!el) return false;
    el.setAttribute('data-ja-root', '1');
    return true;
  });
}

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
      let found = false;
      for (let i = 0; i < 10 && !found; i++) { await page.waitForTimeout(1500); found = await markRoot(page); }
      if (!found) return { status: 'failed', reason: 'Easy Apply form did not open', shot: await snap(page, 'li-noform') };

      let lastStep = '';
      for (let step = 0; step < 15; step++) {
        await page.waitForTimeout(1500 + Math.random() * 1000);
        await markRoot(page);                                // the panel re-renders between steps
        if (await captchaVisible(page)) return await discard(page, { status: 'manual', reason: 'captcha' });
        const modal = page.locator(MODAL).first();

        // Resume step: upload this job's tailored PDF.
        const upload = modal.locator('input[type="file"]').first();
        if (resume && await upload.count()) { await upload.setInputFiles(resume); await page.waitForTimeout(3000); }

        // LinkedIn's own resume picker (saved resumes as radio options) is not a question: it keeps the upload.
        const fields = (await collect(page, MODAL)).filter((f) => f.type !== 'file' && !/\.(pdf|docx?)/i.test(f.label + (f.options || []).join(' '))
          && !/top choice|follow .{0,60}(page|updates|up to date)|review your application/i.test(f.label + ' ' + (f.options || []).join(' ')));
        progress(`LinkedIn: step ${step + 1}, ${fields.length} field(s)`);
        const { answers, unknown } = await resolveFields(fields, job);
        const blocking = unknown;                            // LinkedIn's extra questions are effectively all required
        if (blocking.length) return await discard(page, { status: 'needs_answer', unknown: blocking, shot: await snap(page, 'li-question') });
        progress(`LinkedIn: ${fields.map((f) => `"${f.label.slice(0, 40)}"${f.type === 'radio' ? `[${f.options.join('/')}]` : ''} = ${answers[f.key] ?? (unknown.some((u) => u.key === f.key) ? '??' : '(prefilled)')}`).join(' · ').slice(0, 380)}`);
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
          const errs = (await modal.innerText().catch(() => '')).split('\n').filter((l) => /invalid|required|please (enter|select|make)|must be|whole number|decimal/i.test(l)).slice(0, 4);
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
