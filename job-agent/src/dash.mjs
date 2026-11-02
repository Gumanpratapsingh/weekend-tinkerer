// Read-only dashboard data for the person this agent serves, shown in their Cupboard app (Cupboard -> /internal/dash/*).
// Same views as the owner's hub /jobs pages, but answered by each person's own agent from its own database and folder.
import { existsSync, readFileSync, statSync, openSync, readSync, closeSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, master, DATA, hasSession, secret, privateProfile } from './core.mjs';
import { one, all, getKv } from './db.mjs';
import { SEED } from './answers.mjs';

const COLS = 'id, source, title, company, location, score, status, status_note, found_at, applied_at, url, apply_url';
const dayStart = () => Date.parse(`${new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10)}T00:00:00+05:30`);
const n = (sql, ...p) => one(sql, ...p)?.n || 0;

export function summary() {
  const today = dayStart(), min = config().min_score || 65;
  const byStatus = Object.fromEntries(all('SELECT status, count(*) n FROM jobs GROUP BY status').map((r) => [r.status, r.n]));
  return {
    name: master()?.name || null,
    setup: getKv('onboard') && getKv('onboard') !== 'done' ? getKv('onboard') : null,
    now: JSON.parse(getKv('now') || 'null'),
    paused: getKv('paused') === '1',
    dryRun: (getKv('dry_run') ?? '1') === '1',
    minScore: min,
    connected: { linkedin: hasSession('linkedin'), naukri: hasSession('naukri'), gmail: !!secret('gmail_app_password'), mailbox: privateProfile().mailbox || null },
    today: {
      found: n('SELECT count(*) n FROM jobs WHERE found_at >= ?', today),
      matched: n('SELECT count(*) n FROM jobs WHERE found_at >= ? AND score >= ?', today, min),
      applied: n('SELECT count(*) n FROM jobs WHERE applied_at >= ?', today),
    },
    total: { found: n('SELECT count(*) n FROM jobs'), applied: n('SELECT count(*) n FROM jobs WHERE applied_at IS NOT NULL'),
      interviews: byStatus.interview || 0, learned: n('SELECT count(*) n FROM questions WHERE answer IS NOT NULL') },
    byStatus,
    days: all(`SELECT date((applied_at / 1000) + 19800, 'unixepoch') d, count(*) n FROM jobs WHERE applied_at >= ? GROUP BY d ORDER BY d`, today - 13 * 864e5),
    questions: all(`SELECT q.id, q.question, q.options FROM questions q JOIN asks a ON a.question_id = q.id WHERE a.status = 'open' GROUP BY q.id ORDER BY q.id`),
    attention: all(`SELECT ${COLS} FROM jobs WHERE status IN ('captcha','manual','claimed','needs_answer','interview')
      ORDER BY status = 'interview' DESC, found_at DESC LIMIT 30`),
    drafts: n("SELECT count(*) n FROM referrals WHERE stage IN ('drafted','followup_drafted')"),
  };
}

// "On what basis do you apply for me?": the person's live settings in plain words (Cupboard's Rules page).
export function basis() {
  const c = config(), L = c.locations || {}, caps = c.daily_caps || {};
  const pretty = (t) => String(t).trim().split(/\s+/).map((w) => ({ aws: 'AWS', gcp: 'GCP', sre: 'SRE', devops: 'DevOps', qa: 'QA', vp: 'VP', sde: 'SDE' })[w.toLowerCase()] || w[0].toUpperCase() + w.slice(1)).join(' ');
  const searched = (L.naukri || []).map((x) => x.location).filter(Boolean);
  const cities = searched.filter((x) => x !== 'remote').map(pretty), remote = searched.includes('remote');
  const dry = (getKv('dry_run') ?? '1') === '1', until = Number(getKv('review_until', 0));
  const review = getKv('review_mode') === '1' || (getKv('review_mode') !== '0' && Date.now() < until);
  const day = until ? new Date(until + 5.5 * 3600e3).toISOString().slice(0, 10) : '';
  const on = (x) => (x ? 'connected' : 'not connected');
  // Everything setup asked, as it stands now: the standard questions first, then anything else they have answered since.
  const answered = all('SELECT question, answer FROM questions WHERE answer IS NOT NULL ORDER BY id');
  const answerOf = (q) => answered.find((a) => a.question === q)?.answer;
  const seeds = SEED().map((q) => q.question || q);
  return {
    status: getKv('paused') === '1' ? 'Paused: nothing is being submitted. Send "resume" to restart.'
      : dry ? 'Dry run: it fills forms but submits nothing. Send "go live" when you are ready.'
        : review ? `Review mode${day ? ` until ${day}` : ''}: every application waits for you to tap Submit.` : 'Live: it submits on its own, within the limits below.',
    sections: [
      { heading: 'Roles it looks for', items: (c.tracks?.backend?.queries || []).map(pretty) },
      { heading: 'Cities', items: [L.only_listed ? `${cities.join(', ') || 'No cities listed'}${remote ? ', or remote' : ''}.` : 'Any city in India, or remote.'] },
      { heading: 'Minimum salary', items: [c.min_salary_lpa ? `${c.min_salary_lpa} LPA. Jobs that state less are skipped.` : 'No minimum set.'] },
      { heading: 'Accounts', items: [`Job mailbox: ${privateProfile().mailbox || 'not set'}.`, `Gmail: ${on(!!secret('gmail_app_password'))}.`, `LinkedIn: ${on(hasSession('linkedin'))}.`, `Naukri: ${on(hasSession('naukri'))}.`] },
      { heading: 'Your answers for applications', items: [...seeds.map((q) => `${q} ${answerOf(q) || '(waiting for your answer in chat)'}`),
        ...answered.filter((a) => !seeds.includes(a.question)).map((a) => `${a.question} ${a.answer}`)] },
      { heading: 'Which jobs it applies to', items: [
        `AI fit score of ${c.min_score ?? 65}% or higher, comparing the job with your resume.`,
        ...(c.experience_years ? [`Skips jobs clearly asking for far more than your ${c.experience_years} years.`] : []),
        ...((c.title_exclude || []).length ? [`Skips job titles with: ${c.title_exclude.map(pretty).join(', ')}.`] : []),
        ...((c.exclude_companies || []).length ? [`Never applies to: ${c.exclude_companies.map(pretty).join(', ')}.`] : []),
      ] },
      { heading: 'How much', items: [`LinkedIn: up to ${caps.linkedin} a day.`, `Naukri: up to ${caps.naukri} a day.`, `Company career sites: up to ${caps.ats} a day.`,
        `At most ${caps.total} a day and ${caps.per_company} per company.`] },
      { heading: 'What it sends', items: ['Only facts from your resume and answers you gave. Anything it does not know, it asks you in chat.',
        `For ${c.tailor_min_score ?? 75}%+ matches on LinkedIn and company sites, it adjusts your resume for that job, using only what is already on it.`, 'On Naukri it uses your resume as uploaded.',
        `Recruiter replies and referral messages go out only after you approve them.`] },
    ],
    note: 'Open any job in the Jobs tab to see its score and the reasons for it. To change anything here, ask in your Job agent chat.',
  };
}

export function list({ status = 'matches', q = '', page = 0 }) {
  const term = `%${String(q).slice(0, 60)}%`;
  const where = status === 'all' ? '1' : status === 'matches' ? 'score IS NOT NULL' : 'status = ?';
  const params = ['all', 'matches'].includes(status) ? [] : [String(status)];
  const order = status === 'applied' ? 'applied_at DESC' : ['matches', 'queued', 'ready'].includes(status) ? 'score DESC' : 'found_at DESC';
  return { jobs: all(`SELECT ${COLS} FROM jobs WHERE ${where} AND (title LIKE ? OR company LIKE ?) ORDER BY ${order} LIMIT 40 OFFSET ?`,
    ...params, term, term, Math.max(0, Number(page) || 0) * 40) };
}

export function detail({ id }) {
  const j = one('SELECT * FROM jobs WHERE id = ?', String(id || ''));
  if (!j) return null;
  return { ...j, description: String(j.description || '').slice(0, 8000), resume_path: undefined,
    attempts: all('SELECT at, status, reason FROM attempts WHERE job_id = ? ORDER BY at DESC LIMIT 10', j.id),
    emails: all('SELECT at, direction, from_addr, subject, category FROM emails WHERE job_id = ? ORDER BY at', j.id) };
}

export const memory = () => ({
  open: summary().questions,
  answers: all('SELECT id, question, answer, uses, updated_at FROM questions WHERE answer IS NOT NULL ORDER BY updated_at DESC LIMIT 300'),
});

export function referrals() {
  return { companies: config().referrals?.companies || [],
    rows: all(`SELECT id, company, job_title, job_url, person, headline, profile, alumni, stage, note, followup, reason, created_at, updated_at
      FROM referrals WHERE person IS NOT NULL ORDER BY (stage IN ('drafted','followup_drafted')) DESC, updated_at DESC, created_at DESC LIMIT 200`) };
}

// Live feed: activity lines after byte offset `since` (first call: the last ~150 lines).
export function log({ since }) {
  const f = join(DATA, 'activity.log');
  if (!existsSync(f)) return { lines: [], offset: 0 };
  const size = statSync(f).size;
  let from = Number(since);
  if (!Number.isFinite(from) || from > size) from = Math.max(0, size - 30_000);
  const len = Math.min(size - from, 100_000), buf = Buffer.alloc(len);
  const fd = openSync(f, 'r'); readSync(fd, buf, 0, len, from); closeSync(fd);
  let lines = buf.toString('utf8').split('\n').filter((l) => Number.isFinite(Date.parse(l.slice(0, 24))));
  if (since == null) lines = lines.slice(-150);
  return { lines, offset: from + len };
}

// The phone's browser while it works on one of this person's jobs (JPEG), else null.
export function screen() {
  try { writeFileSync(join(DATA, 'live-watch'), String(Date.now())); } catch { /* best effort */ }
  const meta = (() => { try { return JSON.parse(readFileSync(join(DATA, 'live.json'), 'utf8')); } catch { return {}; } })();
  const img = join(DATA, 'live.jpg');
  if (!meta.task || !existsSync(img) || Date.now() - statSync(img).mtimeMs > 20e3) return null;
  return { meta, image: readFileSync(img) };
}
