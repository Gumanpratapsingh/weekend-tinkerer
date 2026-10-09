// Naukri search through the browser worker (needs the owner's session). Descriptions are fetched for new jobs only.
import { config, log } from '../core.mjs';
import { one, setKv } from '../db.mjs';
import { browserTask } from '../browser.mjs';
import { titleOk, locationOk, htmlToText } from './common.mjs';

// Fast lane: jobs from the last day, page 1 only; ones posted within hours are flagged fresh (front of the queue).
export async function fetchNaukriFresh() {
  const c = config();
  const queries = Object.values(c.tracks).flatMap((t) => t.queries).slice(0, c.fresh_lane?.naukri_queries || 8);
  const r = await browserTask('naukri_search', { plan: [{ location: '', queries }], experience: c.experience_years, pages: 1, jobAge: 1 }, 30 * 60e3);
  if (r.status === 'session_expired') { setKv('session_naukri', 'expired'); return []; }
  return toJobs(r.jobs || [], true);
}

export async function fetchNaukri() {
  const c = config();
  const n = c.naukri || {};
  const queries = Object.values(c.tracks).flatMap((t) => t.queries).slice(0, n.queries_per_location || 6);
  const plan = c.locations.naukri.map((l) => ({ location: l.location, queries }));
  const r = await browserTask('naukri_search', { plan, experience: c.experience_years, pages: n.pages || 1, jobAge: n.job_age_days || 1 }, 60 * 60e3);
  const rec = await browserTask('naukri_recommended', {}, 5 * 60e3).catch((e) => { log(`naukri recommended: ${e.message}`); return { jobs: [] }; });
  log(`naukri: ${r.jobs?.length || 0} from search, ${rec.jobs?.length || 0} recommended`);
  r.jobs = [...(r.jobs || []), ...(rec.jobs || [])];
  if (r.status === 'session_expired') { setKv('session_naukri', 'expired'); log('naukri session expired'); }
  return toJobs(r.jobs, false);
}

// New jobs only: open each job page for the full description and whether it applies on the company's site.
async function toJobs(list, freshLane) {
  const out = [];
  for (const j of list || []) {
    if (!titleOk(j.title) || !locationOk(j.location) || one('SELECT 1 FROM jobs WHERE id = ?', `naukri:${j.jobId}`)) continue;
    let description = `${j.snippet}\nSkills: ${j.skills}\nExperience: ${j.experience}`;
    let external = false;
    try {
      const d = await browserTask('naukri_job', { jobId: j.jobId, url: j.url }, 90000);
      if (d.status === 'ok') { description = `${htmlToText(d.description)}\nSkills: ${j.skills}\nExperience: ${j.experience}`; external = d.external; if (d.applied) continue; }
    } catch (e) { log(`naukri jd ${j.jobId}: ${e.message}`); }
    const fresh = freshLane && /just now|minute|hour|today|few/i.test(j.posted || '');
    out.push({ fresh, id: `naukri:${j.jobId}`, source: 'naukri', apply_type: external ? 'external' : 'naukri',
      url: j.url, apply_url: j.url, title: j.title, company: j.company, location: j.location, description, posted_at: j.posted });
  }
  return out;
}
