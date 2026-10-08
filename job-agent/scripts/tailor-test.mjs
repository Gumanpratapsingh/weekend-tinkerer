// Tailors the resume for one live job and prints what changed. Usage: node scripts/tailor-test.mjs [greenhouse-slug] [title-regex]
import { getJson, htmlToText } from '../src/sources/common.mjs';
import { planFor, validate, tailor } from '../src/tailor.mjs';

const [slug = 'twilio', re = 'engineer'] = process.argv.slice(2);
const { jobs } = await getJson(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`);
const j = jobs.find((x) => new RegExp(re, 'i').test(x.title) && /india|remote|bengaluru/i.test(x.location?.name || ''));
const full = await getJson(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs/${j.id}`);
const job = { id: `test:${j.id}`, title: j.title, company: full.company_name, location: j.location.name, description: htmlToText(full.content) };
console.log('JOB:', job.title, '@', job.company, '|', job.location);
const t0 = Date.now();
const out = await tailor(job);
console.log('track:', out.track, '| issues:', out.issues.length ? out.issues : 'none', '| pdf:', out.pdf, `| ${((Date.now() - t0) / 1000).toFixed(1)}s`);
