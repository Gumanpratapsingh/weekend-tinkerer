// LinkedIn Easy Apply with the owner's session (data/sessions/linkedin.json, saved by scripts/login.sh on the Mac).
// Steps through the modal: upload the tailored resume, answer fields from memory, Next/Review/Submit.
import { siteContext, shotPath, progress, capture } from './session.mjs';
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

// People search results -> [{ name, headline, url, degree }] (reads profile links and the card text around them).
// Profile's own name + top card (new layout: name is the first <h2> in main, no <h1>).
async function profileHead(page) {
  const name = (await page.locator('main h1, main h2').first().innerText().catch(() => '')).trim();
  const top = page.locator(`main section:has(h1), main section:has(h2:text-is("${name.replace(/"/g, '\\"')}"))`).first();
  return { name, top, topText: await top.innerText().catch(() => '') };
}

async function peopleOn(page) {
  return page.evaluate(() => {
    const prof = (h) => (/\/in\/[^/?#]+/.exec(h) || [''])[0];
    const seen = new Map();
    for (const a of document.querySelectorAll('main a[href*="/in/"]')) {
      const key = prof(a.href);
      if (!key || seen.has(key) || /\/in\/(me|ACo)/.test(key)) continue;
      // The person's card: grow while the container still holds only THIS profile's links.
      let card = a;
      while (card.parentElement && card.parentElement !== document.body
        && new Set([...card.parentElement.querySelectorAll('a[href*="/in/"]')].map((x) => prof(x.href)).filter(Boolean)).size === 1) card = card.parentElement;
      const text = String(card.innerText || '');
      const lines = text.split('\n').map((x) => x.replace(/\s*•\s*(1st|2nd|3rd\+?)\s*$/, '').trim())
        .filter((x) => x && !/^(•|·)?\s*(1st|2nd|3rd\+?|Connect|Follow|Message|Pending|View .* profile|Status is .*|Mutual connections?.*)$/i.test(x));
      const name = lines[0] || '';
      if (!name || name.length > 60 || /LinkedIn Member/i.test(name)) continue;
      const degree = (/(1st|2nd|3rd)/.exec(text) || [])[1] || '';
      seen.set(key, { name, headline: (lines[1] || '').slice(0, 200), location: lines[2] || '', url: `https://www.linkedin.com${key}/`, degree, text: text.slice(0, 700) });
    }
    return [...seen.values()];
  });
}

export default {
  // Connection request with a note. Returns invited | connected | pending | limit | manual | dry_run.
  async linkedin_connect({ url, note, dryRun = false }) {
    const ctx = await siteContext('linkedin');
    const page = await ctx.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      if (/\/(login|authwall|checkpoint)/.test(page.url())) return { status: 'session_expired' };
      await page.waitForTimeout(4000 + Math.random() * 2000);
      const { name, top, topText } = await profileHead(page);
      if (/·\s*1st|\b1st\b/.test(topText.slice(0, 400))) return { status: 'connected' };
      if (await top.locator('button:has-text("Pending")').count()) return { status: 'pending' };
      // The button labelled for THIS person (the sidebar has "Invite <someone else> to connect" too).
      let btn = page.locator(`main [aria-label="Invite ${name.replace(/"/g, '\\"')} to connect"]`).first();
      if (!await btn.isVisible().catch(() => false)) {                     // Connect hides under "More"
        await top.locator('button[aria-label="More actions"], button:has-text("More")').first().click({ timeout: 6000 }).catch(() => {});
        await page.waitForTimeout(1200);
        btn = page.locator(`[role="menu"] [aria-label="Invite ${name.replace(/"/g, '\\"')} to connect"], [role="menu"] :text-is("Connect")`).first();
      }
      if (!await btn.count()) return { status: 'manual', reason: 'no Connect option (they may only allow Follow)', shot: await snap(page, 'ref-noconnect') };
      await btn.click({ timeout: 8000 });
      await page.waitForTimeout(2000);
      const dialog = page.locator('div[role="dialog"]').last();
      const dtext = await dialog.innerText().catch(() => '');
      if (/weekly (invitation )?limit|reached the (weekly )?limit/i.test(dtext)) return { status: 'limit' };
      if (/enter their email|know .* outside of linkedin/i.test(dtext)) { await page.keyboard.press('Escape'); return { status: 'manual', reason: 'LinkedIn asks for their email to connect' }; }
      let withoutNote = false;
      const addNote = dialog.locator('button:has-text("Add a note")');
      if (note && await addNote.count()) {
        await addNote.click();
        await page.waitForTimeout(1200);
        const box = page.locator('div[role="dialog"] textarea').last();
        if (await box.count()) await box.fill(note);
        else withoutNote = true;                                           // note needs Premium / monthly note limit used
        if (/premium|personalized invitations/i.test(await page.locator('div[role="dialog"]').last().innerText().catch(() => ''))) withoutNote = true;
      } else withoutNote = true;
      progress(`LinkedIn: invite ready for ${url}${withoutNote ? ' (without note)' : ' with note'}`);
      if (dryRun) { const shot = await snap(page, 'ref-dry'); await page.keyboard.press('Escape'); return { status: 'dry_run', withoutNote, shot }; }
      const sendBtn = page.locator('div[role="dialog"] button[aria-label*="Send"], div[role="dialog"] button:has-text("Send")').last();
      if (withoutNote && !await sendBtn.isVisible().catch(() => false)) await page.locator('div[role="dialog"] button:has-text("Send without a note")').click({ timeout: 6000 });
      else await sendBtn.click({ timeout: 8000 });
      await page.waitForTimeout(3000);
      if (/weekly (invitation )?limit/i.test(await page.innerText('body').catch(() => ''))) return { status: 'limit' };
      return { status: 'invited', withoutNote, shot: await snap(page, 'ref-sent') };
    } finally { await ctx.saveSession().catch(() => {}); await ctx.close(); }
  },

  // Are we connected now? Any email they publish in Contact info?
  async linkedin_state({ url }) {
    const ctx = await siteContext('linkedin');
    const page = await ctx.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(3500);
      const { topText } = await profileHead(page);
      const connected = /·\s*1st|\b1st\b/.test(topText.slice(0, 400));
      let email = null;
      if (connected) {
        await page.goto(url.replace(/\/$/, '') + '/overlay/contact-info/', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(3000);
        email = await page.locator('a[href^="mailto:"]').first().getAttribute('href').then((h) => h?.replace('mailto:', '') || null).catch(() => null);
      }
      return { status: 'ok', connected, email };
    } finally { await ctx.close(); }
  },

  // Message a 1st-degree connection, resume attached. Returns sent | manual | dry_run.
  async linkedin_message({ url, text, attach = null, dryRun = false }) {
    const ctx = await siteContext('linkedin');
    const page = await ctx.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(4000);
      const { name } = await profileHead(page);
      // The profile's own Message link goes to /messaging/compose/?recipient=...; open it as a full page.
      const href = await page.locator('main a[href*="/messaging/compose/"][href*="NON_SELF_PROFILE_VIEW"], main a[href*="/messaging/compose/"]').first().getAttribute('href').catch(() => null);
      if (!href) return { status: 'manual', reason: 'no Message link (not connected?)' };
      const composeUrl = new URL(href.replace(/&amp;/g, '&'), 'https://www.linkedin.com');
      composeUrl.searchParams.delete('interop');
      await page.goto(composeUrl.toString(), { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(4000);
      const view = page;
      // Composer opens as an overlay or on /messaging: wait for an editable box either way.
      const box = view.locator('div.msg-form__contenteditable[contenteditable="true"], div[role="textbox"][contenteditable="true"], div[contenteditable="true"][aria-label*="message" i]').last();
      await box.waitFor({ state: 'visible', timeout: 12000 }).catch(() => {});
      progress(`LinkedIn: message box for ${name || url} ${await box.count() ? 'open' : 'not found'}`);
      if (!await box.count()) return { status: 'manual', reason: 'message box did not open', shot: await snap(view, 'ref-nomsg') };
      await box.click(); await box.fill(text);
      if (attach) {
        const file = view.locator('.msg-form input[type="file"], form input[type="file"], input[type="file"]').last();
        if (await file.count()) { await file.setInputFiles(attach); await page.waitForTimeout(5000); }
      }
      if (dryRun) {                                                          // leave no unsent draft or attachment behind
        const shot = await snap(view, 'ref-msg-dry'); await box.fill('');
        await view.locator('button[aria-label*="Remove attachment" i], button[aria-label*="Remove" i]').first().click({ timeout: 2000 }).catch(() => {});
        await view.waitForTimeout(800); return { status: 'dry_run', shot };
      }
      await view.locator('button.msg-form__send-button, button[type="submit"]:has-text("Send"), button:text-is("Send")').last().click({ timeout: 8000 });
      await view.waitForTimeout(3000);
      return { status: 'sent', shot: await snap(view, 'ref-msg-sent') };
    } finally { await ctx.saveSession().catch(() => {}); await ctx.close(); }
  },

  // Find people at a company: SRM alumni first, then engineers in India. Keeps those whose card mentions the company.
  async linkedin_people({ company, school = 'SRM' }) {
    const ctx = await siteContext('linkedin');
    const page = await ctx.newPage();
    const out = new Map();
    try {
      for (const [q, alumni] of [[`${company} ${school}`, true], [`${company} software engineer`, false], [`${company} java`, false]]) {
        await page.goto(`https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(q)}&origin=GLOBAL_SEARCH_HEADER`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        if (/\/(login|authwall|checkpoint)/.test(page.url())) return { status: 'session_expired', people: [] };
        await page.waitForTimeout(4000 + Math.random() * 2000);
        const first = company.toLowerCase().split(/\s+/)[0];
        for (const p of await peopleOn(page)) {
          if (!p.text.toLowerCase().includes(first)) continue;                     // must work there (headline/current)
          const isAlum = alumni && new RegExp(school, 'i').test(p.text);
          if (!out.has(p.url)) out.set(p.url, { ...p, alumni: isAlum });
          else if (isAlum) out.get(p.url).alumni = true;
        }
        progress(`LinkedIn people: "${q}" → ${out.size} so far`);
        await page.waitForTimeout(5000 + Math.random() * 5000);
      }
      await ctx.saveSession().catch(() => {});
      return { status: 'ok', people: [...out.values()].map(({ text, ...p }) => p) };
    } finally { await ctx.close(); }
  },

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
        if (resume && await upload.count()) {
          await upload.setInputFiles(resume);
          await page.waitForTimeout(3500);
          // LinkedIn keeps the previously used resume selected: tick the one we just uploaded, by its file name.
          const name = resume.split('/').pop();
          const mine = modal.locator('label, [role="radio"], div').filter({ hasText: name.slice(0, 40) }).last();
          if (await mine.count()) await mine.click({ timeout: 5000 }).catch(() => {});
          const chosen = await modal.evaluate((root, n) => {
            const r = [...root.querySelectorAll('input[type="radio"]')].find((x) => x.checked);
            return r ? (r.closest('label, div')?.innerText || '').includes(n) : true;
          }, name.slice(0, 40)).catch(() => true);
          progress(`LinkedIn: resume ${chosen ? `"${name}" selected` : 'upload NOT selected, previous resume still ticked'}`);
          if (!chosen) return await discard(page, { status: 'failed', reason: 'could not select the tailored resume', shot: await snap(page, 'li-resume') });
        }

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
const snap = (page, name) => capture(page, name, { fullPage: false });
