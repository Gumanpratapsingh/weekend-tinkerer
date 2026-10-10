// LinkedIn's public (logged-out) job search, Easy Apply jobs only, posted in the last 24 hours.
// Kept gentle: a few queries every few hours. Applying itself happens in the browser with the owner's session.
import { config, log, sleep } from '../core.mjs';
import { getKv, setKv, run } from '../db.mjs';
import { getText, htmlToText, decode, locationOk, titleOk } from './common.mjs';

const pick = (html, re) => decode((re.exec(html)?.[1] || '').replace(/<[^>]+>/g, '').trim());

export async function fetchLinkedin({ fresh = false } = {}) {
  const c = config();
  const queries = Object.values(c.tracks).flatMap((t) => t.queries);
  const seen = new Set();
  const out = [];
  // LinkedIn answers 429 when we search too much: then stay away for an hour.
  if (Number(getKv('linkedin_backoff_until', 0)) > Date.now()) { log('linkedin search: backing off after a 429'); return out; }
  for (const q of queries) {
    for (const { location: loc, remote } of c.locations.linkedin) for (const easy of [true, false]) for (let start = 0; start < (fresh ? 1 : c.linkedin_pages || 3) * 25; start += 25) {
      // f_TPR=r86400: last 24h; f_AL=true: Easy Apply (false: all jobs, applied on the company's site); f_E=2,3: entry + associate
      const url = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${encodeURIComponent(q)}`
        + `&location=${encodeURIComponent(loc)}&f_TPR=${fresh ? 'r3600' : 'r86400'}${easy ? '&f_AL=true' : ''}&f_E=2%2C3${remote ? '&f_WT=2' : ''}&start=${start}`;
      let html;
      try { html = await getText(url); }
      catch (e) {
        log(`linkedin search: ${e.message}`);
        if (/^429/.test(e.message)) { setKv('linkedin_backoff_until', Date.now() + 3600e3); return out; }
        await sleep(60000); break;
      }
      const cards = html.split('<li>').slice(1);
      if (!cards.length) break;                              // no more pages
      for (const card of cards) {
        const id = /jobPosting:(\d+)/.exec(card)?.[1];
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const title = pick(card, /base-search-card__title[^>]*>([\s\S]*?)<\/h3>/);
        const company = pick(card, /base-search-card__subtitle[^>]*>([\s\S]*?)<\/h4>/);
        const location = pick(card, /job-search-card__location[^>]*>([\s\S]*?)<\/span>/);
        if (!titleOk(title) || !(remote || locationOk(location))) continue;
        // Easy Apply jobs are applied on LinkedIn; the rest go through their company site (browser/external.mjs).
        out.push({ fresh, id: `linkedin:${id}`, source: 'linkedin', apply_type: easy ? 'linkedin' : 'external',
          url: `https://www.linkedin.com/jobs/view/${id}/`, apply_url: `https://www.linkedin.com/jobs/view/${id}/`,
          title, company, location, posted_at: pick(card, /datetime="([^"]+)"/) });
      }
      await sleep(7000 + Math.random() * 6000);
    }
  }
  return out;
}

// Description is fetched lazily, only for jobs that survive the title/location filters and dedupe.
export async function linkedinDescription(job) {
  const id = job.id.split(':')[1];
  let html;
  try { html = await getText(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`); }
  catch (e) {
    // Taken down: stop retrying it every scoring round.
    if (/^404/.test(e.message)) run("UPDATE jobs SET status = 'skipped', status_note = 'job removed from LinkedIn' WHERE id = ?", job.id);
    throw e;
  }
  await sleep(2500);
  return htmlToText(/show-more-less-html__markup[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1] || '');
}
