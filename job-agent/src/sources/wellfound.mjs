// Wellfound (startup jobs): its public role pages (/role/l/<role>/india and /role/r/<role> for remote) carry every listing in the
// page's Next.js data, no login needed. Only jobs applied to on Wellfound itself are kept: ATS-synced listings (Greenhouse,
// Ashby, Dover) and auto-posted ones send people elsewhere. Applying needs the person's Wellfound session (browser/wellfound.mjs).
import { config, log, sleep } from '../core.mjs';
import { getText, decode, locationOk, titleOk } from './common.mjs';

const slugOf = (q) => q.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function listings(html) {
  const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  const st = m ? JSON.parse(m[1]).props?.pageProps?.apolloState?.data || {} : {};
  // Each listing's company is the StartupResult whose highlightedJobListings points at it.
  const company = {};
  for (const v of Object.values(st)) if (v.__typename === 'StartupResult') for (const r of v.highlightedJobListings || []) company[r.__ref] = v.name;
  return Object.entries(st).filter(([, v]) => v.__typename === 'JobListingSearchResult').map(([k, v]) => ({ ...v, company: company[k] || '' }));
}

export async function fetchWellfound() {
  const roles = [...new Set(Object.values(config().tracks).flatMap((t) => t.queries.slice(0, 4)).map(slugOf))];
  const seen = new Set();
  const out = [];
  for (const role of roles) for (const path of [`role/l/${role}/india`, `role/r/${role}`]) {
    let html;
    try { html = await getText(`https://wellfound.com/${path}`); }
    catch (e) { if (!/^404/.test(e.message)) log(`wellfound: ${e.message}`); if (/^429/.test(e.message)) return out; continue; }
    for (const j of listings(html)) {
      if (seen.has(j.id) || j.atsSource || j.autoPosted) continue;
      seen.add(j.id);
      const remote = j.remote || j.remoteConfig?.kind === 'REMOTE';
      const location = [...new Set(j.locationNames || [])].join(', ') + (remote ? ` · Remote (${(j.acceptedRemoteLocationNames || []).join(', ') || 'anywhere'})` : '');
      const description = `${decode(j.description || '')}\n\nExperience: ${j.yearsExperienceMin != null ? `${j.yearsExperienceMin}+ years` : 'not stated'}\nCompensation: ${j.compensation || 'not stated'}`;
      if (!titleOk(j.title) || !locationOk(location, description)) continue;
      const url = `https://wellfound.com/jobs/${j.id}-${j.slug}`;
      out.push({ id: `wellfound:${j.id}`, source: 'wellfound', apply_type: 'wellfound', url, apply_url: url, title: j.title.trim(), company: j.company,
        location, description, posted_at: j.liveStartAt ? new Date(j.liveStartAt * 1000).toISOString() : '' });
    }
    await sleep(2500);
  }
  return out;
}
