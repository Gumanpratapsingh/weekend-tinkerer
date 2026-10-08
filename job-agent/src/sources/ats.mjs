// Company career boards with public JSON APIs: Greenhouse, Lever, Ashby. Free, no login, no scraping.
import { config, log, sleep } from '../core.mjs';
import { getKv } from '../db.mjs';
import { getJson, htmlToText, locationOk, titleOk } from './common.mjs';

async function greenhouse(slug) {
  const { jobs } = await getJson(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`);
  const out = [];
  for (const j of jobs) {
    const location = j.location?.name || '';
    if (!titleOk(j.title) || !locationOk(location)) continue;
    const full = await getJson(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs/${j.id}`).catch(() => null);
    out.push({
      id: `greenhouse:${slug}:${j.id}`, source: 'greenhouse', apply_type: 'greenhouse',
      url: j.absolute_url, apply_url: `https://job-boards.greenhouse.io/${slug}/jobs/${j.id}`,
      title: j.title, company: full?.company_name || slug, location,
      description: htmlToText(full?.content || ''), posted_at: j.updated_at,
    });
    await sleep(300);
  }
  return out;
}

async function lever(slug) {
  const jobs = await getJson(`https://api.lever.co/v0/postings/${slug}?mode=json`);
  return jobs.filter((j) => titleOk(j.text) && locationOk(j.categories?.location || j.workplaceType, j.descriptionPlain))
    .map((j) => ({
      id: `lever:${slug}:${j.id}`, source: 'lever', apply_type: 'lever',
      url: j.hostedUrl, apply_url: j.applyUrl, title: j.text, company: slug,
      location: [j.categories?.location, j.workplaceType].filter(Boolean).join(' · '),
      description: [j.descriptionPlain, ...(j.lists || []).map((l) => `${l.text}\n${htmlToText(l.content)}`), j.additionalPlain].join('\n'),
      posted_at: new Date(j.createdAt).toISOString(),
    }));
}

async function ashby(slug) {
  const { jobs } = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${slug}`);
  return jobs.filter((j) => {
    const loc = [j.location, ...(j.secondaryLocations || []).map((s) => s.location), j.isRemote ? 'remote' : ''].join(' ');
    return titleOk(j.title) && locationOk(loc, j.descriptionPlain);
  }).map((j) => ({
    id: `ashby:${slug}:${j.id}`, source: 'ashby', apply_type: 'ashby',
    url: j.jobUrl, apply_url: j.applyUrl || `${j.jobUrl}/application`, title: j.title, company: slug,
    location: [j.location, j.isRemote ? 'Remote' : ''].filter(Boolean).join(' · '),
    description: j.descriptionPlain, posted_at: j.publishedAt,
  }));
}

const BOARDS = { greenhouse, lever, ashby };

export async function fetchAts() {
  const out = [];
  const learned = JSON.parse(getKv('ats_discovered', '{}'));      // boards found through other feeds
  for (const [kind, slugs] of Object.entries(config().ats)) {
    for (const slug of new Set([...slugs, ...(learned[kind] || [])])) {
      try { out.push(...await BOARDS[kind](slug)); }
      catch (e) { log(`ats ${kind}/${slug}: ${e.message}`); }
    }
  }
  return out;
}
