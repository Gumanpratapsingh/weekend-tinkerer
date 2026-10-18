// Gurgaon / Noida / Delhi NCR watch. The person is moving north: every good NCR match goes to their own chat as a link
// within minutes of being found, NCR is searched on its own every half hour, and those jobs are never applied to
// automatically (the person applies themselves). "ncr off" in the chat stops it; "ncr on" starts it again.
import { config, log, activity, istHour, hasSession } from './core.mjs';
import { all, run, getKv, setKv } from './db.mjs';
import { tell } from './whatsapp.mjs';
import { browserTask } from './browser.mjs';

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

// The NCR searches: a rotating slice of the person's role queries per run, so every query is covered every few runs.
export async function fetchNcr() {
  const c = config(), n = N();
  const queries = [...new Set(Object.values(c.tracks).flatMap((t) => t.queries))];
  const backfill = getKv('ncr_backfill') !== 'done';            // first run: the last week, every query
  const start = Number(getKv('ncr_cursor', 0)) % queries.length;
  const slice = backfill ? queries : [...queries, ...queries].slice(start, start + Math.min(n.queries_per_run, queries.length));
  setKv('ncr_cursor', (start + slice.length) % queries.length);
  const out = [];
  if (hasSession('naukri') && getKv('session_naukri') !== 'expired') {
    const { toJobs } = await import('./sources/naukri.mjs');
    for (const location of n.naukri) for (const q of slice) {
      const r = await browserTask('naukri_search', { plan: [{ location, queries: [q] }], experience: c.experience_years,
        pages: backfill ? 3 : 2, jobAge: backfill ? 7 : 1 }, 15 * 60e3).catch((e) => { log(`ncr naukri "${q}": ${e.message}`); return { jobs: [] }; });
      if (r.status === 'session_expired') break;
      out.push(...await toJobs((r.jobs || []).filter((j) => NCR.test(j.location || '')), true));
    }
  }
  const { fetchLinkedin } = await import('./sources/linkedin.mjs');
  out.push(...(await fetchLinkedin({ fresh: true, locations: n.linkedin.map((location) => ({ location })), queries: slice,
    pages: backfill ? 2 : 1, window: backfill ? 'r604800' : 'r86400', allJobs: true, levels: '2%2C3%2C4' })).filter(isNcr));   // + Mid-Senior: many 2-4 yr roles
  if (backfill) setKv('ncr_backfill', 'done');
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

// Send unsent NCR links (good matches from the last two weeks), best first, a few per message.
export async function ncrNotify() {
  if (!ncrOn()) return 0;
  const [from, to] = N().hours, h = istHour();
  if (h < from || h >= to) return 0;                            // found at night: sent in the morning
  const rows = all(`SELECT id, title, company, location, score, apply_url, url, posted_at FROM jobs WHERE status = 'manual' AND score >= ?
    AND found_at >= ? AND id NOT IN (SELECT job_id FROM ncr_sent) ORDER BY score DESC, found_at DESC`, ncrMin(), Date.now() - 14 * 864e5)
    .filter(isNcr).slice(0, 24);
  for (let i = 0; i < rows.length; i += 8) {
    const part = rows.slice(i, i + 8);
    tell(`📍 ${part.length} Gurgaon/Noida job${part.length > 1 ? 's' : ''} for you — apply yourself\n\n`
      + part.map((j, k) => `${k + 1}. ${j.title} @ ${j.company} · ${j.score}%\n   ${j.location}${j.posted_at && !/^\d{4}-/.test(j.posted_at) ? ` · ${j.posted_at}` : ''}\n   ${j.apply_url || j.url}`).join('\n\n')
      + '\n\nApplied? Mark it on your dashboard. "ncr off" stops these.');
    for (const j of part) run('INSERT OR IGNORE INTO ncr_sent(job_id, sent_at) VALUES(?,?)', j.id, Date.now());
  }
  if (rows.length) log(`ncr: sent ${rows.length} link(s)`);
  return rows.length;
}
