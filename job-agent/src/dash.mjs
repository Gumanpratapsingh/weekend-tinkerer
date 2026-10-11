// Read-only dashboard data for the person this agent serves, shown in their Cupboard app (Cupboard -> /internal/dash/*).
// Same views as the owner's hub /jobs pages, but answered by each person's own agent from its own database and folder.
import { existsSync, readFileSync, statSync, openSync, readSync, closeSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, master, DATA, hasSession, secret, privateProfile } from './core.mjs';
import { one, all, getKv } from './db.mjs';

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
