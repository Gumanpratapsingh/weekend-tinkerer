// Read-only dashboard data for the person this agent serves, shown in their Cupboard app (Cupboard -> /internal/dash/*).
// Same views as the owner's hub /jobs pages, but answered by each person's own agent from its own database and folder.
import { existsSync, readFileSync, statSync, openSync, readSync, closeSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, master, DATA, hasSession, secret, privateProfile } from './core.mjs';
import { one, all, getKv } from './db.mjs';
import { TOP_COMPANIES } from './companies.mjs';
import { funnel } from './referrals.mjs';

const COLS = 'id, source, apply_type, title, company, location, score, status, status_note, found_at, applied_at, url, apply_url';
const dayStart = () => Date.parse(`${new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10)}T00:00:00+05:30`);
const n = (sql, ...p) => one(sql, ...p)?.n || 0;

// Where a job was found, in the words people use. Anything that isn't a job site or a job board is a company's own career page.
const BOARDS = ['himalayas', 'jobicy', 'remotive', 'adzuna', 'jooble', 'remoteok', 'wellfound'];
const sourceGroup = (s) => (s === 'naukri' ? 'Naukri' : s === 'linkedin' ? 'LinkedIn' : BOARDS.includes(s) ? 'Job boards' : 'Company career sites');

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
    bySource: Object.values(all('SELECT source, count(*) found, sum(score >= ?) matched, sum(applied_at IS NOT NULL) applied FROM jobs GROUP BY source', min).reduce((o, r) => {
      const g = sourceGroup(r.source), x = (o[g] ??= { source: g, found: 0, matched: 0, applied: 0 });
      x.found += r.found; x.matched += r.matched || 0; x.applied += r.applied || 0;
      return o;
    }, {})),
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
  // Every question it has asked them, in order: the general ones from setup first, then any met on applications since.
  const answers = all('SELECT id, question, answer FROM questions ORDER BY id');
  const cap = c.company_focus?.small_daily_cap, added = c.company_focus?.top || [];
  return {
    status: getKv('paused') === '1' ? 'Paused: nothing is being submitted. Send "resume" to restart.'
      : dry ? 'Dry run: it fills forms but submits nothing. Send "go live" when you are ready.'
        : review ? `Review mode${day ? ` until ${day}` : ''}: every application waits for you to tap Submit.` : 'Live: it submits on its own, within the limits below.',
    sections: [
      { heading: 'Roles it looks for', items: (c.tracks?.backend?.queries || []).map(pretty), edit: { kind: 'roles', value: (c.tracks?.backend?.queries || []).join(', '), hint: 'Separate roles with commas (up to 12).' } },
      { heading: 'Cities', items: [L.only_listed ? `${cities.join(', ') || 'No cities listed'}${remote ? ', or remote' : ''}.` : 'Any city in India, or remote.'], edit: { kind: 'cities', value: L.only_listed ? searched.join(', ') : 'anywhere', hint: 'Separate cities with commas. Add "remote" for remote jobs, or write "anywhere".' } },
      { heading: 'Minimum salary', items: [c.min_salary_lpa ? `${c.min_salary_lpa} LPA. Jobs that state less are skipped.` : 'No minimum set.'], edit: { kind: 'salary', value: String(c.min_salary_lpa ?? 0), hint: 'A number in LPA. Use 0 for no minimum.' } },
      { heading: 'Job mailbox', items: [privateProfile().mailbox || 'Not set.'], edit: { kind: 'mailbox', value: privateProfile().mailbox || '', hint: 'A Gmail address. It receives your recruiter replies and interview invites.' } },
      { heading: 'Accounts', items: [], accounts: [{ key: 'linkedin', label: 'LinkedIn', connected: hasSession('linkedin') }, { key: 'naukri', label: 'Naukri', connected: hasSession('naukri') }, { key: 'gmail', label: 'Gmail', connected: !!secret('gmail_app_password') }] },
      { heading: 'Your answers for applications', items: [], answers },
      { heading: 'Minimum fit score', items: [`${c.min_score ?? 65}%. AI compares each job with your resume and applies only at this score or higher.`], edit: { kind: 'min_score', value: String(c.min_score ?? 65), hint: 'A number from 40 to 95. Lower means more applications but weaker matches.' } },
      { heading: 'Your experience', items: [`${c.experience_years ?? 0} years. Jobs clearly asking for far more are skipped.`], edit: { kind: 'experience', value: String(c.experience_years ?? 0), hint: 'Total years, as a whole number.' } },
      { heading: 'Job titles it skips', items: [(c.title_exclude || []).map(pretty).join(', ') || 'None.'], edit: { kind: 'title_exclude', value: (c.title_exclude || []).map((x) => x.trim()).join(', '), hint: 'Separate words with commas. A job whose title contains one is skipped.' } },
      { heading: 'Companies it never applies to', items: [(c.exclude_companies || []).map(pretty).join(', ') || 'None.'], edit: { kind: 'exclude_companies', value: (c.exclude_companies || []).join(', '), hint: 'Separate company names with commas.' } },
      { heading: 'Well-known companies it applies to first', items: [Number.isFinite(cap) ? 'These go ahead of other companies in the queue.' : 'Not switched on: companies are not ranked by name. Set a daily limit below to switch it on.',
        `Your additions: ${added.join(', ') || 'none.'}`, `Built in: ${TOP_COMPANIES.join(', ')}.`], edit: { kind: 'top_companies', value: added.join(', '), hint: 'Add your own companies, separated by commas. The built-in list stays.' } },
      { heading: 'Other companies each day', items: [Number.isFinite(cap) ? `Up to ${cap} a day. The rest wait in the queue for the next day.` : 'No separate limit.'], edit: { kind: 'small_cap', value: Number.isFinite(cap) ? String(cap) : 'off', hint: 'A number such as 10, or "off" to treat all companies the same.' } },
      { heading: 'How much', items: [`LinkedIn: up to ${caps.linkedin} a day.`, `Naukri: up to ${caps.naukri} a day.`, `Company career sites: up to ${caps.ats} a day.`,
        `At most ${caps.total} a day and ${caps.per_company} per company.`] },
      { heading: 'What it sends', items: ['Only facts from your resume and answers you gave. Anything it does not know, it asks you in chat.',
        ...(c.original_resume_only ? ['Your resume exactly as you gave it, on every application. It is never edited or rewritten.']
          : [`For ${c.tailor_min_score ?? 75}%+ matches on LinkedIn and company sites, it adjusts your resume for that job, using only what is already on it.`]), 'On Naukri it uses your Naukri profile resume.',
        `Recruiter replies and referral messages go out only after you approve them.`] },
    ],
    note: 'Open any job in the Jobs tab to see its score and the reasons for it. Daily limits are fixed to keep your accounts safe.',
  };
}

export function list({ status = 'matches', q = '', page = 0, source = '' }) {
  const term = `%${String(q).slice(0, 60)}%`;
  const where = status === 'all' ? '1' : status === 'matches' ? 'score IS NOT NULL' : 'status = ?';
  const params = ['all', 'matches'].includes(status) ? [] : [String(status)];
  const order = status === 'applied' ? 'applied_at DESC' : ['matches', 'queued', 'ready'].includes(status) ? 'score DESC' : 'found_at DESC';
  const boards = BOARDS.map((b) => `'${b}'`).join(',');
  const from = { naukri: " AND source = 'naukri'", linkedin: " AND source = 'linkedin'", boards: ` AND source IN (${boards})`, company: ` AND source NOT IN ('naukri','linkedin',${boards})` }[source] || '';
  return { jobs: all(`SELECT ${COLS} FROM jobs WHERE ${where}${from} AND (title LIKE ? OR company LIKE ?) ORDER BY ${order} LIMIT 40 OFFSET ?`,
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
  return { companies: config().referrals?.companies || [], funnel: funnel(),
    rows: all(`SELECT id, company, job_title, job_url, person, headline, profile, alumni, stage, note, followup, reason, reply, replied_at, created_at, updated_at
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
