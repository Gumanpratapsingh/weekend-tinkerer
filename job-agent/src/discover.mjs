// Discovery: pull jobs from every source, drop what fails cheap filters or is already known, score the rest,
// and queue the ones at or above min_score for applying.
import { config, log, sleep } from './core.mjs';
import { one, all, run, event, dedupeKey, getKv, setKv } from './db.mjs';
import { experienceOk } from './sources/common.mjs';
import { fetchAts } from './sources/ats.mjs';
import { fetchLinkedin, linkedinDescription } from './sources/linkedin.mjs';
import { fetchRemotive } from './sources/remotive.mjs';
import { fetchFeeds, atsFromUrl } from './sources/feeds.mjs';
import { fetchNaukri } from './sources/naukri.mjs';
import { scoreJob } from './score.mjs';

export const SOURCES = { ats: fetchAts, linkedin: fetchLinkedin, remotive: fetchRemotive, naukri: fetchNaukri, feeds: fetchFeeds };

// Any Greenhouse/Lever/Ashby link seen in a feed adds that company's board to the list searched directly.
function learnBoard(url) {
  const a = atsFromUrl(url);
  if (!a) return;
  const known = JSON.parse(getKv('ats_discovered', '{}'));
  known[a.kind] ||= [];
  if (!known[a.kind].includes(a.slug)) { known[a.kind].push(a.slug); setKv('ats_discovered', JSON.stringify(known)); log(`new ${a.kind} board: ${a.slug}`); }
}

function insert(job) {
  if (one('SELECT 1 FROM jobs WHERE id = ?', job.id)) return false;
  const dedupe = dedupeKey(job.company, job.title);
  const dup = one("SELECT id FROM jobs WHERE dedupe = ? AND status IN ('queued','applying','ready','applied','needs_answer','manual','interview')", dedupe);
  run(`INSERT INTO jobs(id, source, url, apply_url, apply_type, title, company, location, description, posted_at, dedupe, found_at, status, status_note)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    job.id, job.source, job.url, job.apply_url, job.apply_type, job.title, job.company, job.location,
    job.description || '', job.posted_at || '', dedupe, Date.now(), dup ? 'skipped' : 'new', dup ? `same role as ${dup.id}` : null);
  return !dup;
}

export async function discover(sourceName) {
  let jobs = [];
  try { jobs = await SOURCES[sourceName](); } catch (e) { log(`discover ${sourceName}: ${e.message}`); return 0; }
  for (const j of jobs) learnBoard(j.apply_url);
  const added = jobs.filter(insert).length;
  log(`discover ${sourceName}: ${jobs.length} matched filters, ${added} new`);
  return added;
}

// Score new jobs (oldest first). Stops quietly when the free LLM budget runs out; picks up next round.
export async function scoreNew(limit = 25) {
  const min = config().min_score;
  const jobs = all("SELECT * FROM jobs WHERE status = 'new' ORDER BY found_at LIMIT ?", limit);
  let queued = 0;
  for (const job of jobs) {
    if (!job.description && job.source === 'linkedin') {
      try { job.description = await linkedinDescription(job); run('UPDATE jobs SET description = ? WHERE id = ?', job.description, job.id); }
      catch (e) { log(`linkedin jd ${job.id}: ${e.message}`); continue; }
    }
    if (!experienceOk(job.description)) {
      run("UPDATE jobs SET status = 'filtered', status_note = 'asks for more experience' WHERE id = ?", job.id);
      continue;
    }
    let s;
    try { s = await scoreJob(job); } catch (e) { if (e.rateLimited) break; log(`score ${job.id}: ${e.message}`); continue; }
    const status = s.score < min ? 'scored' : job.apply_type === 'external' ? 'manual' : 'queued';
    run('UPDATE jobs SET score = ?, track = ?, score_reasons = ?, status = ? WHERE id = ?', s.score, s.track, s.reasons, status, job.id);
    if (status === 'queued') queued++;
    await sleep(6000);                                 // stay under the free tier's tokens-per-minute limit
    if (status === 'manual') event('manual', `${job.title} @ ${job.company} (${s.score}) — apply yourself: ${job.apply_url}`);
  }
  return queued;
}
