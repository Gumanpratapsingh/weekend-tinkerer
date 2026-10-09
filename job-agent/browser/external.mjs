// Any other careers site: follow the Apply links to the real application form and fill it with the generic engine.
// Hands the job back to the owner only for account walls (we never create accounts), CAPTCHAs (never bypassed),
// or questions only the owner can answer.
import { siteContext, shotPath, progress } from './session.mjs';
import { fillForm, captchaVisible } from './forms.mjs';
import ats from './ats.mjs';

// Sites that require creating a candidate account before applying.
const ACCOUNT_WALL = /myworkdayjobs|workday\.com|taleo\.net|icims\.com|successfactors|oraclecloud\.com|brassring|jobvite\.com\/.*\/login|darwinbox|ultipro|paylocity|adp\.com|kenexa|phenompeople.*login/i;
const APPLY_TEXT = /^(apply( now| for this (job|position|role))?|apply on company (site|website)|easy apply|i'?m interested|submit application|start application|apply online)$/i;
const DONE = /thank you for (applying|your (application|interest))|application (has been )?(submitted|received|sent)|we('ve| have) received your application|successfully (submitted|applied)/i;

async function knownAts(url) {
  const m = /(?:boards|job-boards)\.greenhouse\.io\/([\w-]+)\/jobs\/(\d+)|greenhouse\.io\/embed\/job_app\?.*for=([\w-]+).*token=(\d+)/.exec(url);
  if (m) return { task: 'apply_greenhouse', id: `greenhouse:${m[1] || m[3]}:${m[2] || m[4]}`, apply_url: url };
  const l = /jobs\.lever\.co\/([\w-]+)\/([0-9a-f-]{36})/.exec(url);
  if (l) return { task: 'apply_lever', id: `lever:${l[1]}:${l[2]}`, apply_url: `https://jobs.lever.co/${l[1]}/${l[2]}/apply` };
  const a = /jobs\.ashbyhq\.com\/([\w.-]+)\/([0-9a-f-]{36})/.exec(url);
  if (a) return { task: 'apply_ashby', id: `ashby:${a[1]}:${a[2]}`, apply_url: `https://jobs.ashbyhq.com/${a[1]}/${a[2]}/application` };
  return null;
}

// Form that looks like a job application: has a file input, or an email field plus a few others.
async function formScore(page) {
  return page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const chat = (e) => /chat|bot|search|newsletter|subscribe/i.test(`${e.id} ${e.name} ${e.className} ${e.placeholder || ''} ${e.getAttribute('aria-label') || ''}`);
    const inputs = [...document.querySelectorAll('input, textarea, select')].filter((e) => (e.type === 'file' || vis(e)) && !chat(e) && e.type !== 'checkbox');
    const hasFile = inputs.some((e) => e.type === 'file');
    const hasEmail = inputs.some((e) => e.type === 'email' || /email/i.test(e.name + e.id + (e.placeholder || '')));
    const hasPassword = inputs.some((e) => e.type === 'password' && vis(e));
    const hasName = inputs.some((e) => /name/i.test(`${e.name} ${e.id} ${e.placeholder || ''} ${e.getAttribute('autocomplete') || ''}`));
    return { n: inputs.length, hasFile, hasEmail, hasName, hasPassword };
  });
}

export default {
  async apply_external({ job, resume, dryRun = false, keepOpen = false }) {
    const ctx = await siteContext(/naukri\.com/.test(job.apply_url) ? 'naukri' : /linkedin\.com/.test(job.apply_url) ? 'linkedin' : 'external');
    let page = await ctx.newPage();
    progress(`Company site: opening ${job.title} @ ${job.company}`);
    const snap = async (name) => { const p = shotPath(name); await page.screenshot({ path: p, fullPage: true }).catch(() => {}); return p; };
    try {
      await page.goto(job.apply_url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(3000);

      // Follow Apply links/buttons (new tabs included) until a form shows up. At most 4 hops.
      for (let hop = 0; hop < 4; hop++) {
        const url = page.url();
        progress(`Company site: hop ${hop + 1} at ${url.slice(0, 120)}`);
        // Bot-check walls (DataDome, Cloudflare, "verify you are human"): hand to the owner's CAPTCHA list.
        if (/captcha-delivery|challenges\.cloudflare|\/captcha\b|perimeterx|hcaptcha\.com/i.test(url)
            || /verify (you are|that you're) (a )?human|are you a robot|press (&|and) hold/i.test((await page.innerText('body').catch(() => '')).slice(0, 2000))) {
          if (!keepOpen) return { status: 'manual', reason: 'captcha', shot: await snap('ext-captcha') };
          // Mac handoff: the owner solves it in the open window; then carry on to the form and prefill it.
          console.log('   Bot check on the page: solve it in the browser window, the form will be filled right after.');
          const start = page.url();
          for (let w = 0; w < 150 && page.url() === start; w++) await page.waitForTimeout(2000);
          await page.waitForTimeout(3000);
          continue;
        }
        if (ACCOUNT_WALL.test(url)) return { status: 'manual', reason: `needs an account on ${new URL(url).hostname}`, shot: await snap('ext-account') };
        const known = await knownAts(url);
        if (known) { await ctx.close(); return ats[known.task]({ job: { ...job, id: known.id, apply_url: known.apply_url }, resume, dryRun, keepOpen }); }
        if (/no longer (accepting|available)|position (has been )?(filled|closed)|job (is )?(closed|expired)/i.test(await page.innerText('body').catch(() => ''))) return { status: 'closed' };

        // A form embedded in an iframe: open the iframe's page directly.
        const frameUrl = await page.evaluate(() => [...document.querySelectorAll('iframe')].map((f) => f.src)
          .find((s) => /greenhouse|lever|ashby|workable|smartrecruiters|recruitee|bamboohr|breezy|teamtailor|personio|zohorecruit|apply|career|job/i.test(s || '')));
        if (frameUrl && !/recaptcha|hcaptcha/.test(frameUrl)) { await page.goto(frameUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }); await page.waitForTimeout(2500); continue; }

        const f = await formScore(page);
        if (f.hasPassword && !f.hasFile) return { status: 'manual', reason: `needs an account on ${new URL(page.url()).hostname}`, shot: await snap('ext-account') };
        if (f.hasFile || (f.hasEmail && f.hasName && f.n >= 3)) break;          // reached the application form

        // Let single-page career sites finish rendering; decline cookie banners (privacy-friendly) so they don't cover buttons.
        await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
        await page.locator('button, a').filter({ hasText: /^(reject all|decline( all)?|only (necessary|essential)|necessary only|accept necessary)/i }).first().click({ timeout: 2000 }).catch(() => {});
        await page.mouse.wheel(0, 900).catch(() => {}); await page.waitForTimeout(800); await page.mouse.wheel(0, -900).catch(() => {});

        // Click the most likely Apply control (best-ranked first); follow a popup if it opens one.
        const target = page.locator('a, button, [role="button"], input[type="submit"], input[type="button"]');
        const ranked = [];
        for (const el of await target.all()) {
          const text = ((await el.innerText().catch(() => '')) || (await el.getAttribute('value').catch(() => '')) || (await el.getAttribute('aria-label').catch(() => '')) || '').trim();
          const href = (await el.getAttribute('href').catch(() => '')) || '';
          const rank = /^apply( now)?$/i.test(text) ? 3 : APPLY_TEXT.test(text) ? 2
            : (/apply/i.test(text) && text.length <= 40 && !/applied|how to apply|why apply|apply filter/i.test(text)) || /\/apply\b/i.test(href) ? 1 : 0;
          if (rank) ranked.push({ el, text: text || href, rank });
        }
        ranked.sort((a, b) => b.rank - a.rank);
        let clicked = false;
        for (const { el, text } of ranked) {
          if (!(await el.isVisible().catch(() => false))) continue;
          progress(`Company site: clicking "${text.slice(0, 40)}"`);
          const before = page.url();
          const popup = ctx.waitForEvent('page', { timeout: 12000 }).catch(() => null);
          await el.click({ timeout: 8000 }).catch(() => {});
          const p2 = await popup;
          if (p2) { page = p2; await page.waitForLoadState('domcontentloaded').catch(() => {}); }
          await page.waitForTimeout(3500);
          const g = await formScore(page);
          // Nothing happened (same page, no form, no new tab): try the next-best Apply control.
          if (!p2 && page.url() === before && !g.hasFile && !(g.hasEmail && g.hasName)) continue;
          clicked = true;
          break;
        }
        if (!clicked) {
          const seen = ranked.map((r) => r.text).slice(0, 8);
          progress(`Company site: no Apply control matched; candidates: ${JSON.stringify(seen).slice(0, 200)}`);
          return { status: 'manual', reason: 'could not find the application form', shot: await snap('ext-noform') };
        }
      }
      if (!keepOpen && await captchaVisible(page)) return { status: 'manual', reason: 'captcha', shot: await snap('ext-captcha') };

      progress(`Company site: form found on ${new URL(page.url()).hostname}, filling…`);
      const res = await fillForm(page, job, { root: null, resume, dryRun: dryRun || keepOpen, partial: keepOpen });
      if (keepOpen) return { ...res, status: 'handoff', page };
      const shot = await snap(`ext-${dryRun ? 'dry' : 'filled'}`);
      if (res.status !== 'filled') return { ...res, shot };
      if (!res.fields) return { status: 'manual', reason: 'no fillable form found', shot };

      const submit = page.locator('button[type="submit"], input[type="submit"], button').filter({ hasText: /submit|apply|send application|send/i }).last();
      if (!await submit.count()) return { status: 'manual', reason: 'no submit button found', shot };
      await submit.click({ timeout: 10000 });
      await page.waitForTimeout(6000);
      if (await captchaVisible(page)) return { status: 'manual', reason: 'captcha', shot: await snap('ext-captcha') };
      const body = await page.innerText('body').catch(() => '');
      if (DONE.test(body) || /thank|success|confirm/i.test(page.url())) return { status: 'applied', shot: await snap('ext-done') };
      const errors = await page.locator('[class*="error"]:visible, [aria-invalid="true"]').allInnerTexts().catch(() => []);
      return { status: 'failed', reason: errors.filter(Boolean).slice(0, 4).join(' | ') || 'no confirmation seen', shot: await snap('ext-unsure') };
    } finally { if (!keepOpen) await ctx.close().catch(() => {}); }
  },
};
