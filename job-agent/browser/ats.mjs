// Company career boards: Greenhouse, Lever, Ashby. No login needed; one form per job.
import { siteContext, shotPath, progress } from './session.mjs';
import { fillForm, captchaVisible } from './forms.mjs';

const SITES = {
  greenhouse: { open: async () => {},
    root: 'form#application-form, #application_form, form[action*="applications"], form#application_form',
    submit: 'button[type="submit"]:has-text("Submit"), input[type="submit"], button:has-text("Submit application")' },
  lever: { open: async () => {}, root: 'form[action*="apply"], form',
    submit: '#btn-submit, button[type="submit"]:has-text("Submit")' },
  ashby: { open: async (page) => page.locator('button:has-text("Application"), a:has-text("Application")').first().click({ timeout: 4000 }).catch(() => {}),
    root: 'form, [class*="application-form"]',
    submit: 'button:has-text("Submit Application"), button[type="submit"]' },
};

const DONE = /thank you for (applying|your (application|interest))|application (has been )?(submitted|received)|we('ve| have) received your application|successfully submitted/i;

async function applyAts(kind, { job, resume, dryRun = false, keepOpen = false }) {
  const site = SITES[kind];
  progress(`${kind}: opening ${job.title} @ ${job.company}`);
  const ctx = await siteContext(kind);
  const page = await ctx.newPage();
  try {
    // Greenhouse: the embed URL serves the bare form on every board (company sites wrap it in an iframe).
    const [, slug, id] = String(job.id).split(':');
    const url = kind === 'greenhouse' ? `https://boards.greenhouse.io/embed/job_app?for=${slug}&token=${id}` : job.apply_url;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2500);
    await site.open(page);
    await page.waitForTimeout(1500);
    if (/no longer (accepting|available)|job (has been )?closed|position has been filled/i.test(await page.innerText('body')))
      return { status: 'closed' };

    progress(`${kind}: reading the form…`);
    const res = await fillForm(page, job, { root: site.root, resume, dryRun: dryRun || keepOpen, partial: keepOpen });
    const shot = shotPath(`${kind}-${dryRun ? 'dry' : 'filled'}`);
    await page.screenshot({ path: shot, fullPage: true });
    if (keepOpen) return { ...res, status: 'handoff', page };
    if (res.status !== 'filled') return { ...res, shot };

    progress(`${kind}: filled ${res.filled?.length || 0} fields + resume, submitting`);
    await page.locator(site.submit).first().click({ timeout: 10000 });
    await page.waitForTimeout(6000);
    if (await captchaVisible(page)) return { status: 'manual', reason: 'captcha', shot: await snap(page, `${kind}-captcha`) };
    const body = await page.innerText('body');
    if (DONE.test(body) || /confirmation|thank/i.test(page.url())) return { status: 'applied', shot: await snap(page, `${kind}-done`) };
    const errors = await page.locator('[class*="error"]:visible, [aria-invalid="true"]').allInnerTexts().catch(() => []);
    return { status: 'failed', reason: errors.filter(Boolean).slice(0, 5).join(' | ') || 'no confirmation seen', shot: await snap(page, `${kind}-unsure`) };
  } finally { if (!keepOpen) await ctx.close(); }
}
const snap = async (page, name) => { const p = shotPath(name); await page.screenshot({ path: p, fullPage: true }); return p; };

export default {
  apply_greenhouse: (b) => applyAts('greenhouse', b),
  apply_lever: (b) => applyAts('lever', b),
  apply_ashby: (b) => applyAts('ashby', b),
};
