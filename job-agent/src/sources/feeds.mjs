// Free remote-job feeds (no keys): Himalayas, Jobicy. (RemoteOK and We Work Remotely removed: owner's call, paid platforms.)
// Most link out to the company's own page; links to Greenhouse/Lever/Ashby become auto-apply jobs
// (and the company's board is added to the ATS list), everything else goes to the "apply yourself" list.
import { log, sleep } from '../core.mjs';
import { getJson, getText, htmlToText, decode, locationOk, titleOk } from './common.mjs';

// Greenhouse / Lever / Ashby job URL -> { kind, slug, id, apply_url }, else null.
export function atsFromUrl(url) {
  const u = String(url || '');
  let m = /(?:boards|job-boards)\.greenhouse\.io\/([\w-]+)\/jobs\/(\d+)/.exec(u) || /greenhouse\.io\/embed\/job_app\?.*for=([\w-]+).*token=(\d+)/.exec(u);
  if (m) return { kind: 'greenhouse', slug: m[1], id: m[2], apply_url: `https://job-boards.greenhouse.io/${m[1]}/jobs/${m[2]}` };
  m = /jobs\.lever\.co\/([\w-]+)\/([0-9a-f-]{36})/.exec(u);
  if (m) return { kind: 'lever', slug: m[1], id: m[2], apply_url: `https://jobs.lever.co/${m[1]}/${m[2]}/apply` };
  m = /jobs\.ashbyhq\.com\/([\w.-]+)\/([0-9a-f-]{36})/.exec(u);
  if (m) return { kind: 'ashby', slug: m[1], id: m[2], apply_url: `https://jobs.ashbyhq.com/${m[1]}/${m[2]}/application` };
  return null;
}

function make(source, extId, { title, company, location, description, url, posted }) {
  const ats = atsFromUrl(url);
  return { id: ats ? `${ats.kind}:${ats.slug}:${ats.id}` : `${source}:${extId}`, source, apply_type: ats ? ats.kind : 'external',
    url, apply_url: ats ? ats.apply_url : url, title, company, location, description, posted_at: posted };
}
const keep = (j) => titleOk(j.title) && locationOk(j.location, j.description);


async function himalayas() {
  const out = [];
  for (let offset = 0; offset < 300; offset += 100) {
    const { jobs } = await getJson(`https://himalayas.app/jobs/api?limit=100&offset=${offset}`);
    if (!jobs?.length) break;
    for (const r of jobs) {
      const where = (r.locationRestrictions || []).join(', ');
      out.push(make('himalayas', r.guid || r.applicationLink, { title: r.title, company: r.companyName,
        location: `Remote · ${where || 'Worldwide'}`, description: htmlToText(r.description), url: r.applicationLink, posted: r.pubDate }));
    }
    await sleep(1500);
  }
  return out.filter(keep);
}

async function jobicy() {
  const out = [];
  for (const tag of ['java', 'spring', 'backend', 'ai', 'llm']) {
    const { jobs = [] } = await getJson(`https://jobicy.com/api/v2/remote-jobs?count=50&tag=${tag}`).catch(() => ({}));
    for (const r of jobs) out.push(make('jobicy', r.id, { title: decode(r.jobTitle), company: r.companyName,
      location: `Remote · ${r.jobGeo || ''}`, description: htmlToText(r.jobDescription), url: r.url, posted: r.pubDate }));
    await sleep(1500);
  }
  return out.filter(keep);
}


export async function fetchFeeds() {
  const out = [];
  for (const [name, fn] of Object.entries({ himalayas, jobicy })) {
    try { const got = await fn(); out.push(...got); log(`feeds ${name}: ${got.length} kept`); }
    catch (e) { log(`feeds ${name}: ${e.message}`); }
  }
  return out;
}
