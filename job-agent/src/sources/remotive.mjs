// Remotive: free remote-jobs API. Only roles open to India/worldwide survive locationOk().
import { config, log } from '../core.mjs';
import { getJson, htmlToText, locationOk, titleOk } from './common.mjs';

export async function fetchRemotive() {
  const out = [];
  const queries = Object.values(config().tracks).flatMap((t) => t.queries.slice(0, 2));
  for (const q of queries) {
    let jobs;
    try { ({ jobs } = await getJson(`https://remotive.com/api/remote-jobs?category=software-dev&search=${encodeURIComponent(q)}&limit=50`)); }
    catch (e) { log(`remotive: ${e.message}`); continue; }
    for (const j of jobs) {
      const location = `Remote · ${j.candidate_required_location || ''}`;
      const description = htmlToText(j.description);
      if (!titleOk(j.title) || !locationOk(location, description)) continue;
      out.push({ id: `remotive:${j.id}`, source: 'remotive', apply_type: 'external',
        url: j.url, apply_url: j.url, title: j.title, company: j.company_name, location, description,
        posted_at: j.publication_date });
    }
  }
  return out;
}
