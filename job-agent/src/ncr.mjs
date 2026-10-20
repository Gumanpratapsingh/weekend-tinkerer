// Gurgaon / Noida / Delhi NCR watch. The person is moving north: every good NCR match goes to their own chat as a link
// within minutes of being found, NCR is searched on its own every half hour, and those jobs are never applied to
// automatically (the person applies themselves). "ncr off" in the chat stops it; "ncr on" starts it again.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { config, log, activity, istHour, hasSession, resumeFile } from './core.mjs';
import { one, all, run, getKv, setKv, dedupeKey } from './db.mjs';
import { tell, cardDone } from './whatsapp.mjs';
import { browserTask } from './browser.mjs';
import { askOwner } from './asks.mjs';
import { tailor, baseResume } from './tailor.mjs';
import { getText, htmlToText, decode } from './sources/common.mjs';

run('CREATE TABLE IF NOT EXISTS ncr_sent (job_id TEXT PRIMARY KEY, sent_at INTEGER NOT NULL)');

// Naukri: "delhi-ncr" covers Gurugram, Noida and Delhi (its "ghaziabad"/"faridabad" pages fall back to all of India).
// LinkedIn: a Gurugram search returns the whole metro area (Noida and Delhi included); "Delhi NCR" resolves to Ohio.
const N = () => ({ enabled: true, every_min: 30, hours: [7, 23], min_score: 50, queries_per_run: 9, naukri: ['delhi-ncr'],
  linkedin: ['Gurugram, Haryana, India'], ...(config().ncr || {}) });
export const ncrOn = () => N().enabled !== false && getKv('ncr_off') !== '1';
export const ncrEvery = () => N().every_min;
const NCR = /\b(gurugram|gurgaon|noida|greater noida|delhi|new delhi|ncr|ghaziabad|faridabad)\b/i;
export const isNcr = (job) => NCR.test(String(job?.location || ''));
export const ncrMin = () => N().min_score;
export const NCR_NOTE = 'NCR job: apply yourself (link sent to your chat)';

// The NCR searches, in short runs that survive restarts: MNC Workday sites (every 2 h), then LinkedIn and Naukri for a slice
// of the person's role queries. The place in the query list is saved after every query, so a restart resumes instead of
// starting over. The first full pass looks back a week; after that, the last day.
export async function fetchNcr() {
  const c = config(), n = N();
  const queries = [...new Set(Object.values(c.tracks).flatMap((t) => t.queries))];
  const out = [];
  if (Date.now() - Number(getKv('ncr_workday_at', 0)) > 2 * 3600e3) {
    const { fetchWorkday } = await import('./sources/workday.mjs');
    out.push(...(await fetchWorkday(n.workday_cities || ['Gurgaon', 'Gurugram', 'Noida', 'Delhi']).catch((e) => { log(`ncr workday: ${e.message}`); return []; })).filter(isNcr));
    setKv('ncr_workday_at', Date.now());
  }
  const backfill = getKv('ncr_backfill') !== 'done';
  const per = Math.min(backfill ? 6 : n.queries_per_run, queries.length);
  const { fetchLinkedin } = await import('./sources/linkedin.mjs');
  const { toJobs } = await import('./sources/naukri.mjs');
  // Night (23:00-05:00): only sources that don't use the person's account (Workday, LinkedIn public search). Naukri searches
  // run as their logged-in session, so they rest at night; everything found overnight is scored and ready by the morning.
  const h = istHour(), night = h >= 23 || h < 5;
  const naukriOk = !night && hasSession('naukri') && getKv('session_naukri') !== 'expired';
  for (let k = 0; k < per; k++) {
    const i = Number(getKv('ncr_cursor', 0)) % queries.length, q = queries[i];
    out.push(...(await fetchLinkedin({ fresh: true, locations: n.linkedin.map((location) => ({ location })), queries: [q], pages: backfill ? 2 : 1,
      window: backfill ? 'r604800' : 'r86400', allJobs: true, levels: '2%2C3%2C4' }).catch(() => [])).filter(isNcr));   // + Mid-Senior: many 2-4 yr roles
    if (naukriOk) for (const location of n.naukri) {
      const r = await browserTask('naukri_search', { plan: [{ location, queries: [q] }], experience: c.experience_years,
        pages: backfill ? 3 : 2, jobAge: backfill ? 7 : 1 }, 15 * 60e3).catch((e) => { log(`ncr naukri "${q}": ${e.message}`); return { jobs: [] }; });
      if (r.status !== 'session_expired') out.push(...await toJobs((r.jobs || []).filter((j) => NCR.test(j.location || '')), true));
    }
    setKv('ncr_cursor', (i + 1) % queries.length);
    if (backfill && i + 1 >= queries.length) { setKv('ncr_backfill', 'done'); log('ncr: first week-long pass done'); break; }
  }
  return out;
}

// NCR jobs anywhere short of applied: the queue, waiting on a question, failed or stuck on a CAPTCHA, or scored under the
// apply threshold but above the NCR one (last two weeks). All handed over as links instead of being applied to.
export function ncrSweep() {
  if (!ncrOn()) return 0;
  const rows = all(`SELECT id, location FROM jobs WHERE status IN ('queued','ready','needs_answer')
    OR (found_at >= ? AND (status IN ('failed','captcha') OR (status = 'scored' AND score >= ?)))`, Date.now() - 14 * 864e5, ncrMin()).filter(isNcr);
  for (const r of rows) {
    run("UPDATE jobs SET status = 'manual', status_note = ? WHERE id = ?", NCR_NOTE, r.id);
    run("UPDATE asks SET status = 'dismissed' WHERE job_id = ? AND status = 'open'", r.id);   // no questions for a job they apply to
  }
  if (rows.length) activity(`📍 ${rows.length} Gurgaon/Noida job(s) moved to "apply yourself" — links go to your chat`);
  return rows.length;
}

// Each unsent NCR match (good matches from the last two weeks) as its own card in the "📍 Delhi NCR jobs" chat, best first:
// an "Open job" link plus Fill & show me / I applied / Not for me. Ten per run so the chat stays readable.
export async function ncrNotify() {
  if (!ncrOn()) return 0;
  const [from, to] = N().hours, h = istHour();
  if (h < from || h >= to) return 0;                            // found at night: sent in the morning
  if (getKv('ncr_chat_v2') !== 'done') { run('DELETE FROM ncr_sent'); setKv('ncr_chat_v2', 'done'); }   // re-send the earlier text links as cards
  const rows = all(`SELECT id, title, company, location, score, apply_url, url, posted_at FROM jobs WHERE status = 'manual' AND score >= ?
    AND found_at >= ? AND id NOT IN (SELECT job_id FROM ncr_sent) ORDER BY score DESC, found_at DESC`, ncrMin(), Date.now() - 14 * 864e5)
    .filter(isNcr).slice(0, 10);
  if (rows.length) say(`📍 ${rows.length} new Gurgaon/Noida job${rows.length > 1 ? 's' : ''} ↓`);   // the one ping for this batch
  for (const j of rows) {
    const posted = j.posted_at && !/^\d{4}-/.test(j.posted_at) ? ` · ${j.posted_at}` : '';
    tell(`📍 ${j.title} @ ${j.company} · ${j.score}%\n${j.location}${posted}`,
      { chat: 'ncr', refKind: 'ncrjob', refId: j.id, links: [{ label: 'Open job ↗', url: j.apply_url || j.url }], silent: true });
    run('INSERT OR IGNORE INTO ncr_sent(job_id, sent_at) VALUES(?,?)', j.id, Date.now());
  }
  if (rows.length) log(`ncr: sent ${rows.length} card(s)`);
  return rows.length;
}

function say(text, more = {}) { return tell(text, { chat: 'ncr', ...more }); }
const label = (j) => `${j.title} @ ${j.company}`;

// A job link pasted in the NCR chat: known job, or a new row (Naukri / LinkedIn / any company page).
async function jobFromUrl(url) {
  let m, base;
  if ((m = /naukri\.com\/.*?-(\d{9,})(?:[/?#]|$)/.exec(url))) base = { id: `naukri:${m[1]}`, source: 'naukri', apply_type: 'naukri', url, apply_url: url };
  else if ((m = /linkedin\.com\/jobs\/(?:view\/(?:[^/?#]*-)?|.*[?&]currentJobId=)(\d{6,})/.exec(url))) {
    const u = `https://www.linkedin.com/jobs/view/${m[1]}/`;
    base = { id: `linkedin:${m[1]}`, source: 'linkedin', apply_type: 'linkedin', url: u, apply_url: u };
  } else base = { id: `paste:${createHash('sha1').update(url).digest('hex').slice(0, 12)}`, source: 'paste', apply_type: 'external', url, apply_url: url };
  const known = one('SELECT * FROM jobs WHERE id = ?', base.id);
  if (known) return known;
  let title = 'Job from your link', company = '', location = '', description = '';
  try {
    if (base.source === 'naukri') {
      const d = await browserTask('naukri_job', { jobId: base.id.split(':')[1], url }, 90000);
      description = htmlToText(d.description || ''); if (d.external) base.apply_type = 'external';
    } else if (base.source === 'linkedin') {
      const html = await getText(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${base.id.split(':')[1]}`);
      const pick = (re) => decode((re.exec(html)?.[1] || '').replace(/<[^>]+>/g, '').trim());
      title = pick(/top-card-layout__title[^>]*>([\s\S]*?)<\/h2>/) || title;
      company = pick(/topcard__org-name-link[^>]*>([\s\S]*?)<\/a>/);
      location = pick(/topcard__flavor--bullet[^>]*>([\s\S]*?)<\/span>/);
      description = htmlToText(/show-more-less-html__markup[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1] || '');
    }
  } catch (e) { log(`ncr paste ${base.id}: ${e.message}`); }
  if (base.source === 'naukri') { const t = /naukri\.com\/job-listings-(.+?)-\d{9,}/.exec(url)?.[1] || ''; title = t.replace(/-/g, ' ') || title; }
  run(`INSERT INTO jobs(id, source, url, apply_url, apply_type, title, company, location, description, posted_at, dedupe, found_at, status, status_note, priority)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'manual','pasted in the NCR chat',1)`, base.id, base.source, base.url, base.apply_url, base.apply_type, title, company, location,
    description, '', dedupeKey(company, title), Date.now());
  return one('SELECT * FROM jobs WHERE id = ?', base.id);
}

// Fill-and-show: fill the form WITHOUT submitting, send the screenshots, submit only on "✓ Submit". The answers used are kept
// (kv fillans:<job>) so the real submit types exactly what the screenshots show.
export async function ncrFill(jobId) {
  let job = one('SELECT * FROM jobs WHERE id = ?', jobId);
  if (!job) return say('I can\'t find that job any more.');
  if (job.status === 'applied') return say(`✅ Already applied: ${label(job)}.`);
  say(`🖊 Filling ${label(job)} — I won't submit. Screenshots in a minute or two.`);
  setKv(`fillans:${job.id}`, '{}');
  let resume = job.resume_path && existsSync(job.resume_path) ? job.resume_path : null;
  if (!resume && job.apply_type !== 'naukri') {
    try { const t = job.description ? await tailor(job) : await baseResume(job.track || 'backend'); resume = t.pdf; run('UPDATE jobs SET resume_path = ? WHERE id = ?', resume, job.id); }
    catch (e) { log(`ncr fill resume: ${e.message}`); resume = resumeFile(); }
  }
  let res = await browserTask(`apply_${job.apply_type}`, { job, resume, dryRun: true }, 30 * 60e3).catch((e) => ({ status: 'error', reason: e.message }));
  if (job.apply_type === 'linkedin' && res.status === 'manual' && /company site|not Easy Apply/i.test(res.reason || '')) {
    run("UPDATE jobs SET apply_type = 'external' WHERE id = ?", job.id); job = one('SELECT * FROM jobs WHERE id = ?', job.id);
    res = await browserTask('apply_external', { job, resume, dryRun: true }, 30 * 60e3).catch((e) => ({ status: 'error', reason: e.message }));
  }
  const open = [{ label: 'Open job ↗', url: job.apply_url || job.url }];
  switch (res.status) {
    case 'dry_run': {
      const shots = (res.shots?.length ? res.shots : [res.shot]).filter(Boolean).slice(0, 8);
      const how = job.apply_type === 'naukri' ? 'Naukri applies with your Naukri profile and answers its questions from your memory.' : `Resume: ${resume ? resume.split('/').pop() : 'your profile resume'}.`;
      return say(`📋 Filled ${label(job)} — nothing submitted yet. Check the ${shots.length} screenshot(s) above. ${how}\nSubmit it?`,
        { refKind: 'ncrsubmit', refId: job.id, images: shots, links: open });
    }
    case 'needs_answer': {
      setKv(`ncrwait:${job.id}`, '1');
      for (const u of res.unknown || []) askOwner(u.label, { jobId: job.id, context: `${label(job)} application`, kind: u.type, options: u.options?.length ? u.options : null, chat: 'ncr' });
      return say(`❓ ${label(job)} asks ${(res.unknown || []).length} question(s) I don't know yet (above). Answer them and I'll fill it again automatically.`,
        { images: res.shot ? [res.shot] : [], links: open });
    }
    case 'already_applied': run("UPDATE jobs SET status = 'applied', status_note = 'already applied before' WHERE id = ?", job.id); return say(`✅ Already applied to ${label(job)}.`);
    case 'closed': run("UPDATE jobs SET status = 'skipped', status_note = 'job closed' WHERE id = ?", job.id); return say(`🚫 ${label(job)} is closed.`);
    case 'email': return say(`✉️ ${label(job)} takes applications by email: ${res.email}.`, { links: open });
    default:
      if (/captcha/i.test(res.reason || '')) return captchaHandoff(job, res, open);
      return say(`🖐 Couldn't fill ${label(job)}: ${String(res.reason || res.status).slice(0, 200)}. Apply on the site yourself.`, { images: res.shot ? [res.shot] : [], links: open });
  }
}

// CAPTCHA: same handoff as the queue (apply.mjs): the job waits in the CAPTCHA list and scripts/finish.sh on the Mac opens it prefilled.
function captchaHandoff(job, res, links) {
  run("UPDATE jobs SET status = 'captcha', status_note = 'CAPTCHA: run ./scripts/finish.sh on the Mac' WHERE id = ?", job.id);
  return say(`🧩 ${label(job)} needs a CAPTCHA. Everything else is ready: run ./scripts/finish.sh on the Mac, solve it, press Submit.`, { images: res.shot ? [res.shot] : [], links });
}

// "✓ Submit" after the screenshots: the real application, same answers, then the confirmation screenshot.
export async function ncrSubmit(jobId) {
  const job = one('SELECT * FROM jobs WHERE id = ?', jobId);
  if (!job) return say('I can\'t find that job any more.');
  if (job.status === 'applied') return say(`✅ Already applied: ${label(job)}.`);
  say(`🚀 Submitting ${label(job)}…`);
  const { applyJob } = await import('./apply.mjs');
  const res = await applyJob({ ...job, attempts: 0 }, { dryRun: false }).catch((e) => ({ status: 'error', reason: e.message }));
  run('DELETE FROM kv WHERE key = ?', `fillans:${job.id}`);
  const shots = res.shot ? [res.shot] : [];
  if (res.status === 'applied') return say(`✅ Applied: ${label(job)}.`, { images: shots });
  if (/captcha/i.test(res.reason || '')) return captchaHandoff(job, res, [{ label: 'Open job ↗', url: job.apply_url || job.url }]);
  if (res.status !== 'needs_answer') run("UPDATE jobs SET status = 'manual', status_note = ? WHERE id = ?", NCR_NOTE, job.id);
  return say(`⚠️ ${label(job)} didn't go through: ${String(res.reason || res.status).slice(0, 200)}. ${res.status === 'needs_answer' ? 'Answer the question(s) and tap Fill again.' : 'Apply on the site yourself.'}`,
    { images: shots, links: [{ label: 'Open job ↗', url: job.apply_url || job.url }] });
}

// Taps on the NCR cards.
export async function ncrAction(ref, value) {
  const id = ref.ref_id, v = String(value || '').toLowerCase();
  const done = (text) => cardDone(ref.ref_kind, id, text);
  if (ref.ref_kind === 'ncrjob') {
    if (v === 'fill') { done('Filling…'); ncrFill(id).catch((e) => log(`ncr fill ${id}: ${e.message}`)); return; }   // minutes: never make the tap wait
    if (v === 'referral') {                                  // the card stays open: Fill / I applied still work afterwards
      if (Date.now() - Number(getKv(`ncrref:${id}`, 0)) < 15 * 60e3) return say('🤝 Already looking for people at that company. The drafts will appear here in a minute.');   // double taps
      setKv(`ncrref:${id}`, Date.now());
      const { refForJob } = await import('./referrals.mjs');
      refForJob(id, { chat: 'ncr' }).catch((e) => log(`ncr referral ${id}: ${e.message}`));
      return;
    }
    if (v === 'applied') { run("UPDATE jobs SET status = 'applied', applied_at = ?, status_note = 'applied by you' WHERE id = ?", Date.now(), id); return done('Applied ✓'); }
    if (v === 'skip') { run("UPDATE jobs SET status = 'skipped', status_note = 'not for me (NCR chat)' WHERE id = ?", id); return done('Skipped'); }
  }
  if (ref.ref_kind === 'ncrsubmit') {
    if (v === 'submit') { done('Submitting…'); ncrSubmit(id).catch((e) => log(`ncr submit ${id}: ${e.message}`)); return; }
    run('DELETE FROM kv WHERE key = ?', `fillans:${id}`);
    return done('Cancelled — not submitted');
  }
}

// After an answer: re-fill NCR jobs that were waiting only on questions.
export async function ncrAfterAnswer() {
  for (const r of all("SELECT key FROM kv WHERE key LIKE 'ncrwait:%'")) {
    const id = r.key.slice('ncrwait:'.length);
    if (one("SELECT 1 FROM asks WHERE job_id = ? AND status = 'open'", id)) continue;
    run('DELETE FROM kv WHERE key = ?', r.key);
    await ncrFill(id);
  }
}

// Free text in the NCR chat: a job link to fill, an answer ("Q12 …"), or help.
export async function ncrChat(text) {
  const urls = [...new Set((text.match(/https?:\/\/\S+/g) || []).map((u) => u.replace(/[)>.,]+$/, '')))].slice(0, 10);
  if (urls.length > 1) say(`🖊 ${urls.length} links — filling them one by one, screenshots for each. Nothing is submitted until you tap ✓ Submit.`);
  for (const u of urls) { const job = await jobFromUrl(u); await ncrFill(job.id); }
  if (urls.length) return;
  if (/^ncr( referrals)?( on| off)?$/i.test(text.trim())) { const { handleOwner } = await import('./commands.mjs'); return handleOwner(text.trim().toLowerCase()); }
  const qm = /^q(\d+)[:\s]+([\s\S]+)$/i.exec(text.trim());
  if (qm) { const { onAnswered } = await import('./commands.mjs'); return onAnswered(+qm[1], qm[2]); }
  return say('📍 Paste any job link (Naukri, LinkedIn or a company page) and I\'ll fill the form and send you screenshots — I submit only when you tap ✓ Submit.\nNew Gurgaon/Noida jobs arrive here as cards: Fill & show me / I applied / Not for me.');
}

// Automatic NCR connections: the best recent NCR matches whose company nobody was asked at yet get the 🤝 Find referral search
// (former colleagues, school alumni, senior people in NCR) and PLAIN connection requests go to the top few, so some have
// accepted by the time the person opens the job. The referral message itself still waits for their OK. One job an hour at
// most in the daytime (LinkedIn limits people searches and invites).
// Recruiting agencies and "hiring for a client" posts: nobody inside them can refer you to the actual employer.
const AGENCY = /(talent|hiring|recruit|staffing|placement|manpower|headhunt)|\b(consultants?|consultancy|hr (solutions?|services)|careers?|jobs?|search partners|training|outsourc\w*|for (a|our) client|client of)\b/i;
export async function ncrReferrals() {
  if (!ncrOn() || getKv('ncr_ref_off') === '1') return;
  const h = istHour();
  if (h < 9 || h >= 21 || !hasSession('linkedin') || getKv('session_linkedin') === 'expired') return;
  if (Date.now() - Number(getKv('ncr_ref_last', 0)) < 50 * 60e3) return;                                  // at most one job an hour: LinkedIn limits people searches
  if (one("SELECT count(*) n FROM referrals WHERE stage = 'approved' AND source = 'auto'").n >= 6) return;  // plain requests already queued
  const asked = new Set(all('SELECT DISTINCT lower(company) c FROM referrals').map((r) => r.c));
  const job = all(`SELECT * FROM jobs WHERE status IN ('manual','applied') AND score >= ? AND found_at >= ? ORDER BY score DESC, found_at DESC LIMIT 200`,
    Math.max(ncrMin(), 65), Date.now() - 7 * 864e5).find((j) => isNcr(j) && j.company && !asked.has(j.company.toLowerCase()) && !AGENCY.test(`${j.company} ${j.title}`));
  if (!job) return;
  setKv('ncr_ref_last', Date.now());
  const { connectForJob } = await import('./referrals.mjs');
  await connectForJob(job.id);                      // plain connection requests now; the referral message waits for the person's OK
}
