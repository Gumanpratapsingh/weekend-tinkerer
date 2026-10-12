// Nightly self-review: what needed a human today, grouped into patterns, so the code can be fixed where it matters most.
// Writes data/reviews/<date>.json (read by the morning fix-up session) and sends the top patterns to the owner.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DATA, OWNER, PERSON, istDate } from './core.mjs';
import { all, one } from './db.mjs';
import { tell } from './whatsapp.mjs';

const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return '?'; } };
// One pattern per kind of failure: numbers, quotes and URLs blanked so the same problem on different jobs groups together.
const shape = (s) => String(s || '').replace(/"[^"]*"/g, '"…"').replace(/https?:\/\/\S+/g, 'URL').replace(/\d{3,}/g, 'N')
  .replace(/on [a-z0-9.-]+\.[a-z]{2,}/gi, 'on HOST').split('\n')[0].slice(0, 110);

export function buildReview(day = istDate()) {
  const from = Date.parse(`${day}T00:00:00+05:30`), to = from + 864e5;
  const attempts = all(`SELECT a.status, a.reason, a.task, a.shot, j.id, j.title, j.company, j.source, j.apply_url, j.url
    FROM attempts a LEFT JOIN jobs j ON j.id = a.job_id WHERE a.at >= ? AND a.at < ?`, from, to);
  const byStatus = {};
  for (const a of attempts) byStatus[a.status] = (byStatus[a.status] || 0) + 1;
  const groups = new Map();                       // "status | reason shape | source→host" -> {count, examples}
  for (const a of attempts.filter((x) => !['applied', 'dry_run', 'closed', 'already_applied'].includes(x.status))) {
    const k = `${a.status} | ${shape(a.reason)} | ${a.source}→${host(a.apply_url || a.url)}`;
    const g = groups.get(k) || { pattern: k, count: 0, examples: [] };
    g.count++;
    if (g.examples.length < 3) g.examples.push({ job: a.id, title: a.title, company: a.company, url: a.apply_url || a.url, shot: a.shot });
    groups.set(k, g);
  }
  let errors = [];
  try {
    errors = readFileSync(join(DATA, 'errors.jsonl'), 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((e) => e && Date.parse(e.at) >= from && Date.parse(e.at) < to);
  } catch { /* none */ }
  const errGroups = {};
  for (const e of errors) { const k = `${e.src}/${e.kind}: ${shape(e.message)}`; errGroups[k] = (errGroups[k] || 0) + 1; }
  const asked = all(`SELECT q.id, q.question, q.answer, count(a.id) n FROM asks a JOIN questions q ON q.id = a.question_id
    WHERE a.asked_at >= ? AND a.asked_at < ? GROUP BY q.id ORDER BY n DESC`, from, to);
  return {
    day, person: PERSON || 'owner',
    applied: one('SELECT count(*) n FROM jobs WHERE applied_at >= ? AND applied_at < ?', from, to).n,
    attempts: attempts.length, byStatus,
    patterns: [...groups.values()].sort((a, b) => b.count - a.count),
    errors: Object.entries(errGroups).map(([pattern, count]) => ({ pattern, count })).sort((a, b) => b.count - a.count),
    questions: asked.map((q) => ({ id: q.id, question: q.question, answered: !!q.answer, times: q.n })),
    waiting: { manual: one("SELECT count(*) n FROM jobs WHERE status = 'manual'").n, captcha: one("SELECT count(*) n FROM jobs WHERE status = 'captcha'").n,
      needs_answer: one("SELECT count(*) n FROM jobs WHERE status = 'needs_answer'").n },
  };
}

export function nightlyReview() {
  const r = buildReview();
  const dir = join(DATA, 'reviews');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${r.day}.json`), JSON.stringify(r, null, 2));
  const who = OWNER ? 'your agent' : `${PERSON}'s agent`;
  const top = r.patterns.slice(0, 5).map((p) => `• ${p.count}× ${p.pattern}`).join('\n') || '• nothing needed a human 🎉';
  const errs = r.errors.slice(0, 3).map((e) => `• ${e.count}× ${e.pattern}`).join('\n');
  const qs = r.questions.filter((q) => !q.answered).slice(0, 5).map((q) => `• ${q.question.slice(0, 90)}`).join('\n');
  tell(`🔍 Nightly review (${who}, ${r.day})\nApplied ${r.applied} of ${r.attempts} attempts. Waiting: apply-yourself ${r.waiting.manual}, CAPTCHA ${r.waiting.captcha}, answers ${r.waiting.needs_answer}.`
    + `\n\nWhat needed a human, by pattern:\n${top}`
    + (errs ? `\n\nErrors:\n${errs}` : '')
    + (qs ? `\n\nStill-open questions asked today:\n${qs}` : '')
    + '\n\nThe morning fix-up session reads this and fixes the top patterns.', { toOwner: true });
  return r;
}
export const reviewExists = (day = istDate()) => existsSync(join(DATA, 'reviews', `${day}.json`));
