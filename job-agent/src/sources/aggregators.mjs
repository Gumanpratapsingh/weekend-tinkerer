// Free job aggregators for India (each pulls listings from thousands of sites). Keys from free sign-ups, no card:
//   Adzuna  -> ~/.jobagent/adzuna_id + adzuna_key   (developer.adzuna.com)
//   Jooble  -> ~/.jobagent/jooble_key               (jooble.org/api/about)
// Their links lead to the original posting; applying goes through browser/external.mjs.
import { config, secret, log, sleep } from '../core.mjs';
import { getJson, htmlToText, locationOk, titleOk } from './common.mjs';
import { atsFromUrl } from './feeds.mjs';

const queries = () => Object.values(config().tracks).flatMap((t) => t.queries);
const job = (source, id, { title, company, location, description, url, posted }) => {
  const ats = atsFromUrl(url);
  return { id: ats ? `${ats.kind}:${ats.slug}:${ats.id}` : `${source}:${id}`, source, apply_type: ats ? ats.kind : 'external',
    url, apply_url: ats ? ats.apply_url : url, title, company, location, description, posted_at: posted };
};

async function adzuna() {
  const id = secret('adzuna_id'), key = secret('adzuna_key');
  if (!id || !key) return [];
  const out = [];
  for (const q of queries()) for (let page = 1; page <= 2; page++) {
    let r;
    try { r = await getJson(`https://api.adzuna.com/v1/api/jobs/in/search/${page}?app_id=${id}&app_key=${key}&what=${encodeURIComponent(q)}&results_per_page=50&max_days_old=3&content-type=application/json`); }
    catch (e) { log(`adzuna: ${e.message}`); break; }
    for (const j of r.results || []) out.push(job('adzuna', j.id, { title: htmlToText(j.title), company: j.company?.display_name || '',
      location: j.location?.display_name || 'India', description: htmlToText(j.description), url: j.redirect_url, posted: j.created }));
    if ((r.results || []).length < 50) break;
    await sleep(1200);
  }
  return out.filter((j) => titleOk(j.title) && locationOk(j.location, j.description));
}

async function jooble() {
  const key = secret('jooble_key');
  if (!key) return [];
  const out = [];
  for (const q of queries()) for (let page = 1; page <= 2; page++) {
    let r;
    try {
      r = await getJson(`https://jooble.org/api/${key}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keywords: q, location: 'India', page: String(page), datecreatedfrom: new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10) }) });
    } catch (e) { log(`jooble: ${e.message}`); break; }
    for (const j of r.jobs || []) out.push(job('jooble', j.id, { title: htmlToText(j.title), company: j.company || '',
      location: j.location || 'India', description: htmlToText(j.snippet), url: j.link, posted: j.updated }));
    if ((r.jobs || []).length < 20) break;
    await sleep(1200);
  }
  return out.filter((j) => titleOk(j.title) && locationOk(j.location, j.description));
}

export async function fetchAggregators() {
  const out = [];
  for (const [name, fn] of Object.entries({ adzuna, jooble })) {
    try { const got = await fn(); out.push(...got); if (got.length) log(`🔎 ${name}: ${got.length} jobs`); }
    catch (e) { log(`${name}: ${e.message}`); }
  }
  return out;
}
