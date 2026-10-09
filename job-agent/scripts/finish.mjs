// Mac-side CAPTCHA handoff: opens each CAPTCHA-blocked job with every field filled in and the tailored resume
// attached, waits for the owner to solve the CAPTCHA and press Submit, then marks the job applied on the phone.
// Run through scripts/finish.sh (sets PW_DIR, AGENT_URL and the ssh tunnel to the phone's agent).
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ats from '../browser/ats.mjs';
import { siteContext } from '../browser/session.mjs';
import external from '../browser/external.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const AGENT = process.env.AGENT_URL;
const DONE = /thank you for (applying|your (application|interest))|application (has been )?(submitted|received|sent)|we('ve| have) received your application|successfully (submitted|applied)/i;
const handlers = { greenhouse: ats.apply_greenhouse, lever: ats.apply_lever, ashby: ats.apply_ashby, external: external.apply_external };

async function openForOwner(job, site, applySelector = null) {
  const ctx = await siteContext(site);
  const page = await ctx.newPage();
  await page.goto(job.apply_url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);
  if (applySelector) await page.locator(applySelector).first().click({ timeout: 8000 }).catch(() => {});
  return { status: 'handoff', page, filled: [] };
}

const jobs = await (await fetch(`${AGENT}/internal/captcha-jobs`)).json();
if (!jobs.length) { console.log('No CAPTCHA jobs waiting.'); process.exit(0); }
console.log(`${jobs.length} job(s) need a CAPTCHA.\n`);

for (const [i, job] of jobs.entries()) {
  const resume = job.resume_path ? join(ROOT, 'data', 'handoff', basename(job.resume_path)) : null;
  const run = handlers[job.apply_type] || handlers.external;
  console.log(`(${i + 1}/${jobs.length}) ${job.title} @ ${job.company} — filling the form…`);
  let res;
  // Naukri: open the job signed in and press Apply; you answer Naukri's question panel and the CAPTCHA.
  if (/naukri\.com/.test(job.apply_url)) res = await openForOwner(job, 'naukri', 'button:has-text("Apply"):not(:has-text("company site")), #apply-button');
  else { try { res = await run({ job, resume, keepOpen: true }); } catch (e) { res = { status: 'error', reason: e.message }; } }
  // Couldn't reach a form automatically: still open the job page for you to finish by hand.
  if (res.status !== 'handoff') { console.log(`   (${res.status}: ${res.reason || ''}) — opening the job page for you instead`); res = await openForOwner(job, 'external'); }
  if (resume) console.log(`   Tailored resume to upload if asked: ${resume}`);
  console.log(`   Filled ${res.filled?.length || 0} field(s) and attached the resume.`);
  if (res.unknown?.length) console.log(`   Left for you: ${res.unknown.map((u) => u.label).join(' · ')}`);
  console.log('   In the browser window: check it, solve the CAPTCHA, press Submit. (Close the tab to skip.)');
  const ctx = res.page.context();
  // Only a confirmation that appears AFTER the form opened counts (job pages often say "thank you for your interest").
  const before = await res.page.innerText('body').catch(() => '');
  const startUrl = res.page.url();
  const alreadySaid = DONE.test(before);
  let applied = false;
  for (let t = 0; t < 900 && !applied; t += 2) {                 // up to 15 minutes per job
    const pages = ctx.pages();
    if (!pages.length) break;
    for (const p of pages) {
      const text = await p.innerText('body').catch(() => '');
      const newText = !alreadySaid && DONE.test(text);
      const newUrl = p.url() !== startUrl && /thank|success|confirm/i.test(p.url());
      const formGone = alreadySaid && !(await p.locator('button:has-text("Submit")').count().catch(() => 1)) && DONE.test(text);
      if (newText || newUrl || formGone) applied = true;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (applied) {
    await fetch(`${AGENT}/internal/action`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'applied', id: job.id }) });
    console.log('   ✅ Applied — marked on the phone.\n');
  } else console.log('   Skipped (no confirmation seen). It stays on the CAPTCHA list.\n');
  await ctx.close().catch(() => {});
}
process.exit(0);
