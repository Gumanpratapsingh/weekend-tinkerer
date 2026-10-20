// Naukri, driven through the owner's own logged-in session (data/sessions/naukri.json, from NaukriAutopilot).
// Search uses Naukri's own JSON API from inside the page (same calls the site makes); applying clicks Apply and
// answers the recruiter-question chat drawer from memory.
import { siteContext, shotPath, progress, capture, who } from './session.mjs';
import { oddField } from './forms.mjs';

const H = { appid: '109', systemid: 'Naukri', clientid: 'd3skt0p', gid: 'LOCATION,INDUSTRY,EDUCATION,FAREA_ROLE', 'Content-Type': 'application/json' };
const AGENT = () => `${who().agent}/internal/resolve`;   // the agent of the person this task is for

// One Naukri context per PERSON per browser run (refreshed cookies are saved). Never shared between people: a shared
// one sent the owner's Naukri application from a friend's account on 2026-10-11.
const ctxs = new Map();                               // person -> Promise<context>
async function ctx() {
  const key = who().person;
  const c = ctxs.has(key) && await ctxs.get(key).catch(() => null);
  if (!c || !c.browser()?.isConnected()) ctxs.set(key, siteContext('naukri'));
  return ctxs.get(key);
}
// A page that crashed stays in context.pages() and fails every goto in ~50 ms ("Page crashed"): it wiped whole search cycles.
// Use a live page, and open a fresh one when the old one closed or crashed.
const crashed = new WeakSet();
const watch = (page) => { if (!page.__jaWatched) { page.__jaWatched = true; page.on('crash', () => crashed.add(page)); } return page; };
async function home() {
  const c = await ctx();
  let page = c.pages().find((p) => !p.isClosed() && !crashed.has(p));
  for (const p of c.pages()) if (crashed.has(p)) await p.close().catch(() => {});
  page = watch(page || await c.newPage());
  if (!page.url().includes('naukri.com')) { await page.goto('https://www.naukri.com/mnjuser/homepage', { waitUntil: 'domcontentloaded', timeout: 60000 }); await page.waitForTimeout(3000); }
  return page;
}
const loggedOut = (page) => /nlogin|login/i.test(page.url());

async function api(path) {
  const page = await home();
  return page.evaluate(async ([p, h]) => {
    const r = await fetch(p, { headers: h, credentials: 'include' });
    return { status: r.status, body: r.ok ? await r.json() : await r.text() };
  }, [path, H]);
}

export default {
  async naukri_search({ plan, experience = 2, pages = 1, jobAge = 1 }) {
    const out = [];
    const seen = new Set();
    const tries = new Map();                                       // retries per search page after a crash
    for (const { location: loc, queries } of plan) for (const q of queries) for (let pg = 1; pg <= pages; pg++) {
      // Open the normal search page and read the results the page itself fetches (no API calls of our own).
      const page = await home();
      const slug = `${q.trim().toLowerCase().replace(/\s+/g, '-')}-jobs${loc ? `-in-${loc.toLowerCase()}` : ''}${pg > 1 ? `-${pg}` : ''}`;   // no location = all India
      const respP = page.waitForResponse((res) => res.url().includes('/jobapi/v3/search') && res.request().method() === 'GET', { timeout: 45000 }).catch(() => null);
      try { await page.goto(`https://www.naukri.com/${slug}?experience=${experience}&jobAge=${jobAge}`, { waitUntil: 'domcontentloaded', timeout: 60000 }); }
      catch (e) {
        if (!/crash|closed|detached/i.test(e.message)) throw e;
        console.error('naukri search page died, retrying on a fresh page:', e.message.split('\n')[0]);
        crashed.add(page); await page.close().catch(() => {});
        if ((tries.get(slug) || 0) < 2) { tries.set(slug, (tries.get(slug) || 0) + 1); pg--; }   // same query again, on a new page (home() opens one)
        continue;
      }
      if (loggedOut(page)) return { status: 'session_expired', jobs: out };
      const resp = await respP;
      const r = { status: resp?.status() || 0, body: resp ? await resp.json().catch(() => ({})) : {} };
      if (r.status === 429) return { status: 'rate_limited', jobs: out };      // too many requests: the agent holds off 12-18 h
      if (r.status !== 200) { console.error('naukri search', r.status, slug); if (await page.locator('iframe[src*="recaptcha/api2/bframe"]').count()) return { status: 'captcha', jobs: out }; continue; }
      if (!(r.body.jobDetails || []).length) break;                  // no more pages for this query
      progress(`Naukri: "${q}" page ${pg} (${loc || 'all India'}) → ${(r.body.jobDetails || []).length} jobs · ${out.length + (r.body.jobDetails || []).length} so far`);
      for (const j of r.body.jobDetails || []) {
        if (seen.has(j.jobId)) continue;
        seen.add(j.jobId);
        const ph = Object.fromEntries((j.placeholders || []).map((p) => [p.type, p.label]));
        out.push({ jobId: j.jobId, title: j.title, company: j.companyName, location: ph.location || '', experience: ph.experience || '', salary: ph.salary || '',
          url: j.jdURL ? `https://www.naukri.com${j.jdURL}` : `https://www.naukri.com/job-listings-${j.jobId}`, snippet: j.jobDescription || '', skills: j.tagsAndSkills || '', posted: j.footerPlaceholderLabel || '' });
      }
      await page.waitForTimeout(4000 + Math.random() * 4000);
    }
    await (await ctx()).saveSession();
    progress(`Naukri search done: ${out.length} jobs`);
    return { status: 'ok', jobs: out };
  },

  // Open the job page and read the details response the page itself loads.
  // Naukri's own "Recommended jobs" for this profile: read every job list the page loads.
  async naukri_recommended() {
    const page = await home();
    const lists = [];
    const onResp = async (res) => {
      if (!/jobapi|recom/i.test(res.url()) || res.request().method() !== 'GET') return;
      const b = await res.json().catch(() => null);
      const arr = b?.jobDetails || b?.recommendedJobs || b?.jobs || b?.data?.jobDetails;
      if (Array.isArray(arr)) lists.push(...arr);
    };
    page.on('response', onResp);
    try {
      await page.goto('https://www.naukri.com/mnjuser/recommendedjobs', { waitUntil: 'domcontentloaded', timeout: 60000 });
      if (loggedOut(page)) return { status: 'session_expired', jobs: [] };
      await page.waitForTimeout(8000);
      for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 2500); await page.waitForTimeout(2500); }
    } finally { page.off('response', onResp); }
    const seen = new Set();
    const jobs = lists.filter((j) => j?.jobId && !seen.has(j.jobId) && seen.add(j.jobId)).map((j) => {
      const ph = Object.fromEntries((j.placeholders || []).map((p) => [p.type, p.label]));
      return { jobId: j.jobId, title: j.title, company: j.companyName, location: ph.location || '', experience: ph.experience || '',
        url: j.jdURL ? `https://www.naukri.com${j.jdURL}` : `https://www.naukri.com/job-listings-${j.jobId}`, snippet: j.jobDescription || '', skills: j.tagsAndSkills || '' };
    });
    return { status: 'ok', jobs };
  },

  // Daily profile refresh (what NaukriAutopilot did on the Mac): base resume + next headline variant, verified.
  async naukri_refresh({ resume, headline }) {
    const c = await ctx();
    progress('Naukri: refreshing your profile (resume + headline) so recruiters see it as updated today');
    if (resume) await uploadProfileResume(c, resume);
    const page = await c.newPage();
    try {
      await page.goto('https://www.naukri.com/mnjuser/profile', { waitUntil: 'domcontentloaded', timeout: 60000 });
      if (loggedOut(page)) return { status: 'session_expired' };
      await page.addStyleTag({ content: OVERLAY_CSS }).catch(() => {});
      await page.waitForTimeout(3000);
      if (headline) {
        const edit = await firstVisible(page, ['#lazyResumeHead span.edit', '#resumeHeadline span.edit', "[id*='resumeHeadline'] span.edit", 'span.edit.icon']);
        if (!edit) return { status: 'error', reason: 'headline edit control not found' };
        await edit.click({ force: true });
        await page.waitForTimeout(1200);
        const box = await firstVisible(page, ['#resumeHeadlineTxt', "textarea[id*='resumeHeadline']", 'form textarea']);
        if (!box) return { status: 'error', reason: 'headline box did not open' };
        await box.fill(headline);
        const save = await firstVisible(page, ["button[type='submit']:has-text('Save')", "button:has-text('Save')"]);
        await save?.click({ force: true });
        await page.waitForTimeout(3000);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(3000);
        const ok = (await page.innerText('body')).replace(/\s+/g, ' ').includes(headline.slice(0, 40));
        if (!ok) return { status: 'error', reason: 'headline did not stick' };
      }
      progress('Naukri: profile refreshed ✓ (shows "updated today")');
      return { status: 'ok' };
    } finally { await c.saveSession().catch(() => {}); await page.close(); }
  },

  async naukri_job({ jobId, url }) {
    const c = await ctx();
    const page = await c.newPage();
    try {
      const respP = page.waitForResponse((res) => res.url().includes(`/jobapi/v4/job/${jobId}`), { timeout: 45000 }).catch(() => null);
      await page.goto(url || `https://www.naukri.com/job-listings-${jobId}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      if (loggedOut(page)) return { status: 'session_expired' };
      const resp = await respP;
      const body = resp?.ok() ? await resp.json().catch(() => null) : null;
      await page.waitForTimeout(1500);
      const d = body?.jobDetails;
      const description = d?.description || await page.locator('[class*="JDC__dang-inner-html"], [class*="job-desc"], section[class*="job-desc"]').first().innerHTML().catch(() => '');
      const companySite = await page.locator('#company-site-button, button:has-text("Apply on company site")').count();
      const applied = await page.locator('#already-applied, button:has-text("Applied")').count();
      return { status: description ? 'ok' : 'error', description, external: !!(companySite || d?.applyRedirectUrl), applied: !!applied };
    } finally { await page.close(); }
  },

  async apply_naukri({ job, resume, dryRun = false }) {
    progress(`Naukri: applying to ${job.title} @ ${job.company}`);
    const c = await ctx();
    const page = await c.newPage();
    try {
      // Search results once stored "https://www.naukri.comundefined" when the listing had no jdURL: rebuild it from the job id.
      const jobUrl = /^https:\/\/www\.naukri\.com(undefined)?\/?$/.test(job.url || '') ? `https://www.naukri.com/job-listings-${String(job.id).replace(/^naukri:/, '')}` : job.url;
      await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(4000);
      if (loggedOut(page)) return { status: 'session_expired' };
      const body = await page.innerText('body');
      if (/already applied|applied\s*$/im.test(body.slice(0, 4000)) && await page.locator('#already-applied, button:has-text("Applied")').count()) return { status: 'already_applied' };
      if (await page.locator('button:has-text("Apply on company site"), #company-site-button').count()) return { status: 'manual', reason: 'company site' };
      const apply = page.locator('#apply-button, button.apply-button, button:has-text("Apply")').first();
      if (!await apply.count()) return { status: 'closed' };

      // Naukri applies with the profile resume. The owner's ORIGINAL resume stays there (recruiters search and download
      // it), so nothing is uploaded per job. Only the daily refresh (naukri_refresh) touches it, with the base resume.

      if (dryRun) return { status: 'dry_run', shot: await snap(page, 'naukri-dry') };
      const applyResp = page.waitForResponse((r) => r.url().includes('/apply-workflow/') && r.request().method() === 'POST', { timeout: 15000 }).catch(() => null);
      await apply.click();
      await page.waitForTimeout(4000);
      const quota = await quotaHit(await applyResp);
      if (quota || await refused(page)) return { status: 'site_limit', reason: `Naukri refused the apply: ${quota || 'error while processing your request'}`, shot: await snap(page, 'naukri-limit') };

      // Questions drawer: one question at a time, chat-style.
      let lastQ = '', sameQ = 0;
      for (let i = 0; i < 25; i++) {
        if (await done(page)) return { status: 'applied', shot: await snap(page, 'naukri-done') };
        const drawer = page.locator('.chatbot_DrawerContentWrapper, [class*="chatbot_Drawer"], [class*="chatbot"]').first();
        if (!await drawer.count()) break;
        const q = await currentQuestion(page);
        if (!q) { await page.waitForTimeout(2000); continue; }
        // The same question again and again (13 times on 2026-10-19, ending as "no confirmation seen" and retried 3 times): the answer
        // is not being accepted. Stop after 3 and hand it to the person with the question named, instead of burning the attempt.
        sameQ = q.label === lastQ ? sameQ + 1 : 1; lastQ = q.label;
        if (sameQ >= 4) return { status: 'manual', reason: `Naukri keeps asking "${q.label.slice(0, 100)}" and does not accept the answer`, shot: await snap(page, 'naukri-stuck-question') };
        progress(`Naukri asks: "${q.label.slice(0, 120)}"`);
        const r = await fetch(AGENT(), { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ context: `${job.title} at ${job.company} (Naukri)`, fields: [{ key: 'a', label: q.label, type: q.options.length ? 'choice' : 'text', options: q.options, required: true }] }) });
        if (r.status === 503) throw new Error('AI busy, retry later');
        const { answers, unknown } = await r.json();
        const odd = oddField(unknown);
        if (odd) return { ...odd, shot: await snap(page, 'naukri-question') };
        if (unknown.length) return { status: 'needs_answer', unknown, shot: await snap(page, 'naukri-question') };
        await answer(page, q, answers.a);
        await page.waitForTimeout(2500);
      }
      if (await done(page)) return { status: 'applied', shot: await snap(page, 'naukri-done') };
      if (await refused(page)) return { status: 'site_limit', reason: 'Naukri refused the apply: error while processing your request', shot: await snap(page, 'naukri-limit') };
      return { status: 'failed', reason: 'no confirmation seen', shot: await snap(page, 'naukri-unsure') };
    } finally { await c.saveSession().catch(() => {}); await page.close(); }
  },
};

// Naukri's apply API answers 403 {"message":"Daily quota of jobs exceeded", customErrorCode 403009} once an account
// has used its daily applies; the page only shows "There was an error while processing your request".
async function quotaHit(res) {
  if (!res || res.status() !== 403) return '';
  const j = await res.json().catch(() => null);
  return /quota/i.test(JSON.stringify(j || '')) ? (j?.message || 'daily quota exceeded') : '';
}
async function refused(page) {
  const t = await page.innerText('body').catch(() => '');
  return /error while processing your request/i.test(t.slice(0, 3000));
}

async function done(page) {
  const t = await page.innerText('body').catch(() => '');
  return /you have successfully applied|applied successfully|application sent|successfully applied/i.test(t) || /\/myapply\/saveApply|applied=true/i.test(page.url());
}

async function currentQuestion(page) {
  return page.evaluate(() => {
    const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const bot = [...document.querySelectorAll('[class*="botMsg"], [class*="bot-msg"], li.botItem, [class*="chatbot_ListItem"]')].map((e) => clean(e.innerText)).filter(Boolean);
    const label = bot.at(-1);
    if (!label) return null;
    const options = [...document.querySelectorAll('[class*="chatbot_Drawer"] input[type="radio"], [class*="chatbot_Drawer"] input[type="checkbox"], .ssrc__radio-btn-container label, [class*="chipsContainer"] [class*="chip"]')]
      .map((e) => clean(e.labels?.[0]?.innerText || e.value || e.innerText)).filter(Boolean);
    return { label, options: [...new Set(options)] };
  });
}

async function answer(page, q, value) {
  if (q.options.length) {
    const opt = page.locator('[class*="chatbot_Drawer"] label, [class*="chatbot_Drawer"] [class*="chip"]', { hasText: value }).first();
    await opt.click({ timeout: 5000 });
  } else {
    const box = page.locator('[class*="chatbot_Drawer"] [contenteditable="true"], [class*="chatbot_Drawer"] textarea, [class*="chatbot_Drawer"] input[type="text"]').first();
    await box.click();
    await box.fill(String(value)).catch(() => page.keyboard.type(String(value)));
  }
  await page.locator('[class*="chatbot_Drawer"] [class*="sendMsg"], [class*="chatbot_Drawer"] button:has-text("Save"), [class*="chatbot_Drawer"] [class*="send"]').first().click({ timeout: 5000 });
}

const OVERLAY_CSS = '#ni-desktop-nps-profile,#ni-desktop-nps,.md__backdrop,[class*="nps-widget"]{display:none!important;pointer-events:none!important}';
const firstVisible = async (page, sels) => { for (const s of sels) { const l = page.locator(s).first(); if (await l.isVisible().catch(() => false)) return l; } return null; };

async function uploadProfileResume(c, pdf) {
  const p = await c.newPage();
  try {
    await p.goto('https://www.naukri.com/mnjuser/profile', { waitUntil: 'domcontentloaded', timeout: 60000 });
    const inp = p.locator('input#attachCV, input[type="file"][id*="attach"], input[type="file"]').first();
    await inp.waitFor({ state: 'attached', timeout: 10000 });
    await inp.setInputFiles(pdf);
    await p.waitForTimeout(8000);
  } finally { await p.close(); }
}
const snap = (page, name) => capture(page, name, { fullPage: false });
