// Any other careers site: follow the Apply links to the real application form and fill it with the generic engine.
// Hands the job back to the owner only for account walls (we never create accounts), CAPTCHAs (never bypassed),
// or questions only the owner can answer.
import { siteContext, shotPath, progress, capture } from './session.mjs';
import { fillForm, captchaVisible } from './forms.mjs';
import ats from './ats.mjs';

// Sites that require creating a candidate account before applying.
const ACCOUNT_WALL = /myworkdayjobs|myworkdaysite|workday\.com|taleo\.net|icims\.com|successfactors|oraclecloud\.com|brassring|jobvite\.com\/.*\/login|darwinbox|ultipro|paylocity|adp\.com|kenexa|phenompeople.*login/i;
const APPLY_TEXT = /^(apply( now| for this (job|position|role))?|apply on company (site|website)|easy apply|i'?m interested|submit application|start application|apply online)$/i;
// New tabs that are ad/analytics trackers, not the job page (e.g. a doubleclick tab opened by the Apply click).
const TRACKER = /doubleclick\.net|googleadservices|googlesyndication|google-analytics|googletagmanager|facebook\.com\/tr|bat\.bing|linkedin\.com\/px|ads\.|adservice|analytics\./i;
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

// Small company sites often take applications by email ("send your resume to jobs@…", or an Apply link that is a
// mailto: with the role in the subject). Pick the address for this job: a mailto whose subject matches the title best,
// else one careers-style address named on the page. Returns {email, subject} or null.
export async function emailApply(page, job) {
  const found = await page.evaluate(() => {
    // Skip honeypot-style links hidden from people (aria-hidden or pushed off-screen); hidden modals are fine.
    const trap = (a) => a.getAttribute('aria-hidden') === 'true' || a.getAttribute('tabindex') === '-1' || /-9999px|opacity-\[0\.0/.test(a.className || '');
    const all = [...document.querySelectorAll('a[href^="mailto:" i]')].filter((a) => !trap(a));
    const links = all.map((a) => a.getAttribute('href'));
    const onApply = all.filter((a) => /apply/i.test(a.innerText || a.getAttribute('aria-label') || '')).map((a) => a.getAttribute('href'));
    const text = document.body.innerText || '';
    const said = [...text.matchAll(/(?:send|email|mail|forward|share)[^.\n]{0,60}?(?:resume|cv|profile|application)[^.\n]{0,40}?([\w.+-]+@[\w-]+(?:\.[\w-]+)+)/gi)].map((m) => m[1]);
    return { links, onApply, said };
  }).catch(() => ({ links: [], onApply: [], said: [] }));
  const norm = (x) => ` ${String(x || '').toLowerCase().replace(/\.net\b/g, 'dot net').replace(/[^a-z0-9]+/g, ' ')} `;
  const words = (x) => norm(x).trim().split(' ').filter((w) => w.length > 1 && !/^(the|and|for|of|in|at|to|sr|jr|ii|iii)$/.test(w));
  const want = words(job.title);
  const opts = found.links.map((h) => {
    const m = /^mailto:([^?]+)(?:\?(.*))?$/i.exec(h || '');
    if (!m) return null;
    const subject = decodeURIComponent((/(?:^|&)subject=([^&]*)/i.exec(m[2] || '') || [])[1] || '').replace(/\+/g, ' ');
    const have = words(subject);
    const overlap = want.filter((w) => have.includes(w)).length;
    return { email: decodeURIComponent(m[1]).trim(), subject, score: subject ? overlap / Math.max(1, want.length) : 0 };
  }).filter((o) => o && /@/.test(o.email) && !/privacy|support|info@|sales|press|media|legal|abuse|noreply|no-reply/i.test(o.email));
  const best = opts.filter((o) => o.subject).sort((a, b) => b.score - a.score)[0];
  if (best && best.score >= 0.5) return { email: best.email, subject: best.subject };
  if (opts.some((o) => o.subject)) return null;                     // role-specific addresses, none for this role
  const one = (list) => { const u = [...new Set(list.map((e) => String(e).replace(/^mailto:/i, '').split('?')[0].trim().toLowerCase()))].filter((e) => /@/.test(e)); return u.length === 1 ? u[0] : null; };
  // 1) "send your resume to X" on the page, 2) the address behind the Apply button, 3) one careers-style address.
  const pick = one(found.said) || one(found.onApply)
    || one(opts.map((o) => o.email).filter((e) => /career|job|hr|recruit|talent|hiring|resume|cv|people/i.test(e)));
  return pick ? { email: pick, subject: '' } : null;
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
    // Record every address the page asks to open in a new tab (LinkedIn's Apply does this): the real company link
    // can then be opened directly, without chasing tabs or tracker redirects.
    await ctx.addInitScript(() => {
      const open = window.open;
      window.__jaOpened = [];
      window.open = function (u, ...rest) { try { window.__jaOpened.push(new URL(String(u), location.href).href); } catch { /* bad url */ } return open.call(this, u, ...rest); };
    });
    let page = await ctx.newPage();
    progress(`Company site: opening ${job.title} @ ${job.company}`);
    const snap = (name) => capture(page, name);
    try {
      await page.goto(job.apply_url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(3000);

      // Follow Apply links/buttons (new tabs included) until a form shows up. At most 4 hops.
      for (let hop = 0; hop < 4; hop++) {
        // Still on the job board (Naukri / LinkedIn) while the company site opened in another tab, sometimes seconds later
        // (Naukri shows "You were redirected to the company website"): switch to that tab.
        if (/naukri\.com|linkedin\.com/.test(page.url())) {
          const offBoard = () => ctx.pages().filter((p) => p !== page && !p.isClosed() && /^https?:/.test(p.url()) && !TRACKER.test(p.url()) && !/naukri\.com|linkedin\.com/.test(p.url())).at(-1);
          for (let w = 0; w < 15 && !offBoard() && /showAcp|redirected to the company/i.test(page.url() + (await page.innerText('body').catch(() => '')).slice(0, 600)); w++) await page.waitForTimeout(1000);
          const other = offBoard();
          if (other) { progress(`Company site: switching to the company tab ${other.url().slice(0, 90)}`); page = other; await page.waitForLoadState('domcontentloaded').catch(() => {}); await page.waitForTimeout(2000); }
        }
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
        const bodyText = await page.innerText('body').catch(() => '');
        if (/no longer (accepting|available)|not (currently )?accepting applications|applications? (are |is )?(now )?closed|position (has been )?(filled|closed)|job (is |has )?(closed|expired)|this job (posting )?(has )?expired/i.test(bodyText)) return { status: 'closed' };
        // Already applied on the job board (an earlier attempt or by hand): nothing left to do.
        if ((/naukri\.com/.test(url) && await page.locator('#already-applied, button:has-text("Applied"):visible').count().catch(() => 0))
          || (/linkedin\.com/.test(url) && /\bApplied \d+ (seconds?|minutes?|hours?|days?|weeks?|months?) ago\b/i.test(bodyText.slice(0, 4000)))) return { status: 'already_applied' };

        // A form embedded in an iframe: open the iframe's page directly.
        // Only visible frames, never trackers (LinkedIn job pages carry a hidden doubleclick frame whose URL mentions
        // "/jobs/": following it lost 27 applications), and only frames that look like an application form.
        const frameUrl = (await page.evaluate(() => [...document.querySelectorAll('iframe')]
          .filter((f) => { const r = f.getBoundingClientRect(); return r.width > 200 && r.height > 150; }).map((f) => f.src)).catch(() => []))
          .find((u) => /^https?:/.test(u || '') && !TRACKER.test(u) && !/recaptcha|hcaptcha|youtube|vimeo|maps\.google|facebook|twitter|linkedin\.com/i.test(u)
            && /greenhouse|lever|ashby|workable|smartrecruiters|recruitee|bamboohr|breezy|teamtailor|personio|zohorecruit|\/apply|application|careers?\//i.test(u));
        if (frameUrl) { await page.goto(frameUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }); await page.waitForTimeout(2500); continue; }

        const f = await formScore(page);
        if (f.hasPassword && !f.hasFile) return { status: 'manual', reason: `needs an account on ${new URL(page.url()).hostname}`, shot: await snap('ext-account') };
        if (f.hasFile || (f.hasEmail && f.hasName && f.n >= 3)) break;          // reached the application form

        // Let single-page career sites finish rendering; decline cookie banners (privacy-friendly) so they don't cover buttons.
        await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
        await page.locator('button, a').filter({ hasText: /^\s*(reject all|decline|only (necessary|essential)|necessary only|accept necessary)/i }).first().click({ timeout: 2000 }).catch(() => {});
        await page.mouse.wheel(0, 900).catch(() => {}); await page.waitForTimeout(800); await page.mouse.wheel(0, -900).catch(() => {});

        // Click the most likely Apply control (best-ranked first); follow a popup if it opens one.
        const target = page.locator('a, button, [role="button"], input[type="submit"], input[type="button"]');
        const ranked = [];
        for (const el of await target.all()) {
          const text = ((await el.innerText().catch(() => '')) || (await el.getAttribute('value').catch(() => '')) || (await el.getAttribute('aria-label').catch(() => '')) || '').trim();
          const href = (await el.getAttribute('href').catch(() => '')) || '';
          if (/^mailto:/i.test(href)) continue;                      // email applications are handled below
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
          // Every tab the click opens (the company site, and often an ad-tracker tab too) is collected; once their real
          // addresses are known, trackers are closed and the real page is followed.
          const opened = [];
          const onPage = (pg) => opened.push(pg);
          ctx.on('page', onPage);
          // A cookie banner or overlay can swallow the click: decline cookies, then press it anyway.
          await el.click({ timeout: 8000 }).catch(async () => {
            await page.locator('button, a').filter({ hasText: /^\s*(reject all|decline|only (necessary|essential)|necessary only|accept necessary)/i }).first().click({ timeout: 2000 }).catch(() => {});
            await el.click({ timeout: 5000 }).catch(() => el.click({ force: true, timeout: 5000 }).catch(() => {}));
          });
          // LinkedIn asks "Share your profile?" before sending people to the company site: Continue opens it.
          // Newer pages use a native <dialog> whose Continue is a link through linkedin.com/safety/go?url=<company page>.
          const share = page.locator('dialog, [role="dialog"], .artdeco-modal').filter({ hasText: /share your profile/i }).locator('button, a').filter({ hasText: /^\s*continue\s*$/i }).first();
          let via = null;
          if (/linkedin\.com/.test(page.url()) && await share.isVisible({ timeout: 3000 }).catch(() => false)) {
            progress('Company site: LinkedIn "Share your profile?" → Continue');
            try { via = new URL(await share.getAttribute('href'), page.url()).searchParams.get('url'); } catch { /* a button, no link */ }
            await share.click({ timeout: 8000 }).catch(() => {});
          }
          let p2 = null;
          // Best: the company address the page itself tried to open (window.open, or the Continue link), followed in this same tab.
          await page.waitForTimeout(1500);
          const asked = [...(await page.evaluate(() => window.__jaOpened || []).catch(() => [])), ...(via ? [via] : [])].filter((u) => /^https?:/.test(u) && !TRACKER.test(u) && !/linkedin\.com/.test(u));
          if (asked.length) {
            progress(`Company site: following ${asked.at(-1).slice(0, 100)}`);
            for (const pg of opened) await pg.close().catch(() => {});
            await page.goto(asked.at(-1), { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
            await page.waitForTimeout(2500);
            opened.length = 0;
          }
          // The click itself navigated this tab onto a tracker: step back and treat it as a new-tab click.
          if (TRACKER.test(page.url())) { await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {}); }
          for (let w = 0; w < 24 && !p2 && !asked.length; w++) {               // up to ~12 s
            await page.waitForTimeout(500);
            for (const pg of opened) {
              const u = pg.isClosed() ? '' : pg.url();
              if (!u || u === 'about:blank') continue;
              if (TRACKER.test(u)) { await pg.close().catch(() => {}); continue; }
              p2 = pg;
            }
            if (!opened.length && w >= 7) break;               // nothing opened after ~4 s: same-page navigation or a dud
          }
          ctx.off('page', onPage);
          for (const pg of opened) if (pg !== p2 && !pg.isClosed() && TRACKER.test(pg.url())) await pg.close().catch(() => {});
          if (p2) { page = p2; await page.waitForLoadState('domcontentloaded').catch(() => {}); }
          await page.waitForTimeout(3500);
          const g = await formScore(page);
          // Nothing happened (same page, no form, no new tab): try the next-best Apply control.
          if (!p2 && !asked.length && page.url() === before && !g.hasFile && !(g.hasEmail && g.hasName)) continue;
          clicked = true;
          break;
        }
        if (!clicked) {
          const mail = await emailApply(page, job);
          if (mail) { progress(`Company site: applications go by email to ${mail.email}`); return { status: 'email', email: mail.email, subject: mail.subject, shot: await snap('ext-email') }; }
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

      // Only a Submit the person could actually press (hidden duplicates made clicks time out).
      const submit = page.locator('button[type="submit"]:visible, input[type="submit"]:visible, button:visible').filter({ hasText: /submit|apply|send application|send/i }).last();
      if (!await submit.count()) return { status: 'manual', reason: 'no submit button found', shot };
      // Submit stays disabled while a required field is empty: name the empty fields instead of clicking in vain.
      if (!await submit.isEnabled().catch(() => true)) {
        const empty = await page.evaluate(() => [...document.querySelectorAll('input[required], select[required], textarea[required], [aria-required="true"]')]
          .filter((e) => !e.value && e.type !== 'hidden').map((e) => (e.labels?.[0]?.innerText || e.getAttribute('aria-label') || e.placeholder || e.name || '').trim()).filter(Boolean).slice(0, 6));
        return { status: 'failed', reason: `form incomplete, Submit disabled${empty.length ? `: empty ${empty.join(', ')}` : ''}`, shot };
      }
      await submit.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
      // A sticky footer or cookie bar can sit on top of it: then press it directly.
      await submit.click({ timeout: 10000 }).catch(async () => {
        await submit.click({ force: true, timeout: 5000 }).catch(() => submit.evaluate((b) => (b.form?.requestSubmit ? b.form.requestSubmit(b.type === 'submit' ? b : undefined) : b.click())));
      });
      await page.waitForTimeout(6000);
      // Emailed "security code" / "confirm you're a human" step (Greenhouse and others): a human check for the owner.
      if (/security code|verification code (was|has been) sent|confirm you'?re a human/i.test(await page.innerText('body').catch(() => '')))
        return { status: 'manual', reason: 'captcha (emailed security code)', shot: await snap('ext-securitycode') };
      if (await captchaVisible(page)) return { status: 'manual', reason: 'captcha', shot: await snap('ext-captcha') };
      const body = await page.innerText('body').catch(() => '');
      if (DONE.test(body) || /thank|success|confirm/i.test(page.url())) return { status: 'applied', shot: await snap('ext-done') };
      const errors = await page.locator('[class*="error"]:visible, [aria-invalid="true"]').allInnerTexts().catch(() => []);
      return { status: 'failed', reason: errors.filter(Boolean).slice(0, 4).join(' | ') || 'no confirmation seen', shot: await snap('ext-unsure') };
    } finally { if (!keepOpen) await ctx.close().catch(() => {}); }
  },
};
