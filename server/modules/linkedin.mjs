// Weekly LinkedIn post drafts from the week's commits. Drafts only: nothing is ever posted
// automatically. Private repo names are replaced before anything is sent to Groq, and drafts that
// mention blocked words are discarded.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HOME, load, save, push, groq, daily, istDate, log } from '../core.mjs';

const USER = 'Gumanpratapsingh';
const BLOCK = /finzly|client|password|secret|token|\.env|\.pem|api[ _-]?key|lunchbox/i;
let data = load('linkedin.json', { drafts: [] });
const persist = () => save('linkedin.json', data);

async function gh(path) {
  const tokenFile = join(HOME, '.github_token');
  const headers = existsSync(tokenFile) ? { Authorization: `Bearer ${readFileSync(tokenFile, 'utf8').trim()}` } : {};
  const r = await fetch(`https://api.github.com${path}`, { headers });
  if (!r.ok) throw new Error(`GitHub ${r.status}`);
  return r.json();
}

async function weekCommits() {
  const since = new Date(Date.now() - 7 * 86400e3).toISOString();
  const repos = (await gh('/user/repos?affiliation=owner&sort=pushed&per_page=15'))
    .filter((r) => !r.fork && r.pushed_at >= since);
  const lines = []; const blocked = [];
  let n = 0;
  for (const r of repos) {
    const label = r.private ? `project ${++n}` : r.name;
    if (r.private) blocked.push(r.name);
    const commits = await gh(`/repos/${USER}/${r.name}/commits?since=${since}&per_page=20`);
    for (const c of commits) lines.push(`[${label}] ${c.commit.message.split('\n')[0]}`);
  }
  return { lines, blocked };
}

async function draft() {
  const { lines, blocked } = await weekCommits();
  if (!lines.length) return null;
  const out = await groq([{ role: 'user', content:
    `Draft a LinkedIn post for a software engineer (Java/Spring by day, weekend builder) about what he built this week,
based on these commit messages:\n${lines.join('\n')}\n
Style: first person, genuine, specific, no hype words ("thrilled", "excited to announce"), 80-150 words,
short paragraphs, one concrete lesson learned, end with a question to readers, at most 3 relevant hashtags.
Never mention anything labelled "project N" by that label; describe private work only in general terms.
Never mention employers, clients, credentials or anything secret. Reply as JSON {"post": "..."}` }],
  { json: true, maxTokens: 1200, temperature: 0.7 });
  const post = String(out.post || '').trim();
  const re = new RegExp([BLOCK.source, ...blocked.map((b) => b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'project \\d'].join('|'), 'i');
  if (!post || re.test(post)) { log('linkedin draft rejected by blocklist'); return null; }
  const d = { id: randomUUID(), date: istDate(), post, status: 'draft', commits: lines.length };
  data.drafts.push(d); persist();
  return d;
}

export default {
  start() {
    daily(19, 0, async () => {
      const d = await draft();
      if (d) await push('LinkedIn draft ready', `${d.post.slice(0, 180)}...\n\nApprove or regenerate it on your hub (/linkedin).`, { tags: 'memo' });
    }, { days: [5] });   // Fridays
  },
  routes: {
    'GET /api/linkedin': () => ({ drafts: [...data.drafts].reverse().slice(0, 30) }),
    'POST /api/linkedin/draft': async () => (await draft()) || { error: 'No commits in the last 7 days to write about.' },
    'POST /api/linkedin/status': ({ body }) => {
      const d = data.drafts.find((x) => x.id === body.id);
      if (!d || !['approved', 'skipped', 'draft'].includes(body.status)) throw Object.assign(new Error('Unknown draft.'), { status: 400, expose: true });
      d.status = body.status;
      if (typeof body.post === 'string' && body.post.trim()) d.post = body.post.trim().slice(0, 3000);
      persist();
      return d;
    },
  },
};
