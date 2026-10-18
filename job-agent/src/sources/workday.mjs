// MNC career sites on Workday (Gartner, Visa, Mastercard, NatWest, TNS…): their public job-search API, searched by city.
// Boards are learned from the apply links the agent has followed (activity.log: "opening <title> @ <company>" then a hop
// to <tenant>.wdN.myworkdayjobs.com/<site>), plus a few seeds. Used by the NCR watch (src/ncr.mjs).
import { statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { DATA, log, sleep } from '../core.mjs';
import { getKv, setKv, one } from '../db.mjs';
import { htmlToText, titleOk, UA } from './common.mjs';

const SEEDS = { 'mastercard|wd1|CorporateCareers': 'Mastercard', 'gartner|wd5|EXT': 'Gartner', 'travelhrportal|wd1|Jobs': 'Travelport',
  'tnsi|wd1|Search': 'TNS', 'rbs|wd3|RBS': 'NatWest Group' };
const LINK = /https?:\/\/([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([A-Za-z0-9_-]+)/;

export function workdayBoards() {
  const boards = { ...SEEDS, ...JSON.parse(getKv('workday_boards', '{}')) };
  try {                                                         // the last ~8 MB of the activity log
    const f = join(DATA, 'activity.log'), size = statSync(f).size, from = Math.max(0, size - 8e6);
    const fd = openSync(f, 'r'), buf = Buffer.alloc(size - from);
    readSync(fd, buf, 0, buf.length, from); closeSync(fd);
    let company = '';
    for (const line of buf.toString('utf8').split('\n')) {
      const o = / opening .+ @ (.+)$/.exec(line);
      if (o) { company = o[1].trim(); continue; }
      const m = LINK.exec(line);
      if (m && !['job', 'wday'].includes(m[3])) { const k = `${m[1]}|${m[2]}|${m[3]}`; boards[k] ||= company || m[1]; }
    }
  } catch { /* no log yet */ }
  setKv('workday_boards', JSON.stringify(boards));
  return boards;
}

async function wd(url, body) {
  const r = await fetch(url, { method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(30000),
    headers: { 'User-Agent': UA, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

// Jobs at each board matching the city names (Workday's search text matches the location), newest details fetched once.
export async function fetchWorkday(cities) {
  const out = [], seen = new Set();
  for (const [key, company] of Object.entries(workdayBoards())) {
    const [t, w, site] = key.split('|'), host = `https://${t}.${w}.myworkdayjobs.com`;
    for (const city of cities) {
      let r;
      try { r = await wd(`${host}/wday/cxs/${t}/${site}/jobs`, { appliedFacets: {}, limit: 20, offset: 0, searchText: city }); }
      catch (e) { log(`workday ${t}/${site}: ${e.message.slice(0, 80)}`); break; }   // board gone or renamed: skip it this run
      for (const j of r.jobPostings || []) {
        const id = `workday:${t}:${(j.bulletFields || [])[0] || j.externalPath}`;
        if (seen.has(id) || !titleOk(j.title) || one('SELECT 1 FROM jobs WHERE id = ?', id)) continue;
        seen.add(id);
        let d = {};
        try { d = (await wd(`${host}/wday/cxs/${t}/${site}${j.externalPath}`)).jobPostingInfo || {}; } catch { /* list data only */ }
        const location = [d.location || j.locationsText, ...(d.additionalLocations || [])].filter(Boolean).join('; ');
        const url = d.externalUrl || `${host}/${site}${j.externalPath}`;
        out.push({ id, source: 'workday', apply_type: 'external', url, apply_url: url, title: j.title, company, location,
          description: htmlToText(d.jobDescription || ''), posted_at: j.postedOn || '' });
        await sleep(800);
      }
      await sleep(1500);
    }
  }
  log(`workday: ${Object.keys(workdayBoards()).length} boards, ${out.length} new jobs`);
  return out;
}
