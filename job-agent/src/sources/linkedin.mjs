// LinkedIn's public (logged-out) job search, Easy Apply jobs only, posted in the last 24 hours.
// Kept gentle: a few queries every few hours. Applying itself happens in the browser with the owner's session.
import { config, log, sleep } from '../core.mjs';
import { getText, htmlToText, decode, locationOk, titleOk } from './common.mjs';

const pick = (html, re) => decode((re.exec(html)?.[1] || '').replace(/<[^>]+>/g, '').trim());

export async function fetchLinkedin() {
  const c = config();
  const queries = Object.values(c.tracks).flatMap((t) => t.queries);
  const seen = new Set();
  const out = [];
  for (const q of queries) {
    for (const { location: loc, remote } of c.locations.linkedin) {
      // f_TPR=r86400: last 24h; f_AL=true: Easy Apply; f_E=2,3: entry + associate; f_WT=1,2,3: on-site/remote/hybrid
      const url = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${encodeURIComponent(q)}`
        + `&location=${encodeURIComponent(loc)}&f_TPR=r86400&f_AL=true&f_E=2%2C3${remote ? '&f_WT=2' : ''}&start=0`;
      let html;
      try { html = await getText(url); } catch (e) { log(`linkedin search: ${e.message}`); await sleep(60000); continue; }
      for (const card of html.split('<li>').slice(1)) {
        const id = /jobPosting:(\d+)/.exec(card)?.[1];
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const title = pick(card, /base-search-card__title[^>]*>([\s\S]*?)<\/h3>/);
        const company = pick(card, /base-search-card__subtitle[^>]*>([\s\S]*?)<\/h4>/);
        const location = pick(card, /job-search-card__location[^>]*>([\s\S]*?)<\/span>/);
        if (!titleOk(title) || !(remote || locationOk(location))) continue;
        out.push({ id: `linkedin:${id}`, source: 'linkedin', apply_type: 'linkedin',
          url: `https://www.linkedin.com/jobs/view/${id}/`, apply_url: `https://www.linkedin.com/jobs/view/${id}/`,
          title, company, location, posted_at: pick(card, /datetime="([^"]+)"/) });
      }
      await sleep(4000 + Math.random() * 4000);
    }
  }
  return out;
}

// Description is fetched lazily, only for jobs that survive the title/location filters and dedupe.
export async function linkedinDescription(job) {
  const id = job.id.split(':')[1];
  const html = await getText(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`);
  await sleep(2500);
  return htmlToText(/show-more-less-html__markup[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1] || '');
}
