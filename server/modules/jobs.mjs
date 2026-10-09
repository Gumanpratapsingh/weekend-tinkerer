// Job agent dashboard (job-agent/): reads the agent's SQLite database read-only and forwards owner actions
// (answer a question, pause, go live, skip...) to the agent's localhost-only API. Owner login required like every route.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { HOME } from '../core.mjs';

const DIR = join(HOME, 'jobagent', 'data');
const DB = join(DIR, 'agent.db');
let db;
function q(sql, ...p) {
  if (!db) { if (!existsSync(DB)) return []; db = new DatabaseSync(DB, { readOnly: true }); }
  return db.prepare(sql).all(...p);
}
const one = (sql, ...p) => q(sql, ...p)[0];
const kv = (k) => one('SELECT value FROM kv WHERE key = ?', k)?.value ?? null;
const dayStart = () => Date.parse(`${new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10)}T00:00:00+05:30`);
const minScore = () => { try { return JSON.parse(readFileSync(join(HOME, 'jobagent', 'profile', 'config.json'), 'utf8')).min_score || 65; } catch { return 65; } };
const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });
const COLS = 'id, source, title, company, location, score, track, status, status_note, found_at, applied_at, url, apply_url';

async function agent(body) {
  const r = await fetch('http://127.0.0.1:8083/internal/action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
  }).catch(() => null);
  if (!r?.ok) throw fail(503, 'The job agent is not responding. It may be restarting.');
  return r.json();
}

export default {
  routes: {
    'GET /api/jobs': () => {
      if (!existsSync(DB)) return { installed: false };
      const today = dayStart();
      const n = (sql, ...p) => one(sql, ...p)?.n || 0;
      const byStatus = Object.fromEntries(q('SELECT status, count(*) n FROM jobs GROUP BY status').map((r) => [r.status, r.n]));
      return {
        installed: true,
        minScore: minScore(),
        now: JSON.parse(kv('now') || 'null'),
        paused: kv('paused') === '1',
        dryRun: (kv('dry_run') ?? '1') === '1',
        today: {
          found: n('SELECT count(*) n FROM jobs WHERE found_at >= ?', today),
          matched: n('SELECT count(*) n FROM jobs WHERE found_at >= ? AND score >= ?', today, minScore()),
          applied: n('SELECT count(*) n FROM jobs WHERE applied_at >= ?', today),
          replies: n("SELECT count(*) n FROM emails WHERE at >= ? AND direction = 'in'", today),
        },
        total: {
          found: n('SELECT count(*) n FROM jobs'),
          applied: n('SELECT count(*) n FROM jobs WHERE applied_at IS NOT NULL'),
          interviews: byStatus.interview || 0,
          rejected: byStatus.rejected || 0,
          learned: n('SELECT count(*) n FROM questions WHERE answer IS NOT NULL'),
        },
        byStatus,
        bySource: q('SELECT source, count(*) n, sum(applied_at IS NOT NULL) applied FROM jobs GROUP BY source ORDER BY n DESC'),
        days: q(`SELECT date((applied_at / 1000) + 19800, 'unixepoch') d, count(*) n FROM jobs
          WHERE applied_at >= ? GROUP BY d ORDER BY d`, today - 13 * 86400e3),
        questions: q(`SELECT qq.id, qq.question, count(a.id) waiting FROM questions qq JOIN asks a ON a.question_id = qq.id
          WHERE a.status = 'open' GROUP BY qq.id ORDER BY qq.id`),
        events: q('SELECT at, kind, text FROM events ORDER BY id DESC LIMIT 60'),
        mail: q("SELECT at, from_addr, subject, category FROM emails WHERE direction = 'in' ORDER BY at DESC LIMIT 15"),
        attention: q(`SELECT ${COLS} FROM jobs WHERE status IN ('captcha','manual','needs_answer','interview') ORDER BY status = 'interview' DESC, status = 'captcha' DESC, found_at DESC LIMIT 40`),
      };
    },

    'GET /api/jobs/list': ({ query }) => {
      const status = String(query.status || 'matches');
      const term = `%${String(query.q || '').slice(0, 60)}%`;
      const page = Math.max(0, Number(query.page) || 0);
      const where = status === 'all' ? '1' : status === 'matches' ? 'score IS NOT NULL' : 'status = ?';
      const params = ['all', 'matches'].includes(status) ? [] : [status];
      const order = status === 'applied' ? 'applied_at DESC' : ['matches', 'queued', 'ready'].includes(status) ? 'score DESC' : 'found_at DESC';
      return { jobs: q(`SELECT ${COLS} FROM jobs WHERE ${where} AND (title LIKE ? OR company LIKE ?) ORDER BY ${order} LIMIT 40 OFFSET ?`,
        ...params, term, term, page * 40) };
    },

    'GET /api/jobs/detail': ({ query }) => {
      const j = one('SELECT * FROM jobs WHERE id = ?', String(query.id || ''));
      if (!j) throw fail(404, 'No such job.');
      return { ...j, description: String(j.description || '').slice(0, 8000),
        hasResume: !!(j.resume_path && existsSync(j.resume_path)),
        hasShot: !!(/\.png$/.test(j.status_note || '') && existsSync(j.status_note)),
        emails: q('SELECT at, direction, from_addr, subject, category, body FROM emails WHERE job_id = ? ORDER BY at', j.id) };
    },

    // The tailored resume PDF or the last screenshot of the application, as base64.
    'GET /api/jobs/file': ({ query }) => {
      const j = one('SELECT resume_path, status_note FROM jobs WHERE id = ?', String(query.id || ''));
      const path = query.kind === 'resume' ? j?.resume_path : j?.status_note;
      if (!path || !path.startsWith(DIR + '/') || path.includes('..') || !existsSync(path)) throw fail(404, 'Not available.');
      return { name: path.split('/').pop(), type: path.endsWith('.pdf') ? 'application/pdf' : 'image/png', data: readFileSync(path).toString('base64') };
    },

    // Live activity feed: lines appended since byte offset `since` (first call: the last ~200 lines).
    'GET /api/jobs/log': ({ query }) => {
      const f = join(DIR, 'activity.log');
      if (!existsSync(f)) return { lines: [], offset: 0, searchesToday: 0 };
      const size = statSync(f).size;
      let since = Number(query.since);
      if (!Number.isFinite(since) || since > size) since = Math.max(0, size - 48_000);
      const len = Math.min(size - since, 200_000);
      const buf = Buffer.alloc(len);
      const fd = openSync(f, 'r'); readSync(fd, buf, 0, len, since); closeSync(fd);
      let lines = buf.toString('utf8').split('\n').filter((l) => Number.isFinite(Date.parse(l.slice(0, 24))));   // skip broken multi-line fragments
      if (!query.since) lines = lines.slice(-200);
      // Searches today (cheap scan of the tail; the file is small and append-only).
      const day = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
      const tail = readFileSync(f, 'utf8').slice(-600_000).split('\n');
      const dayOf = (l) => { const t = Date.parse(l.slice(0, 24)); return Number.isFinite(t) ? new Date(t + 5.5 * 3600e3).toISOString().slice(0, 10) : null; };
      const today = tail.filter((l) => l && dayOf(l) === day);
      return { lines, offset: since + len,
        searchesToday: today.filter((l) => /page \d+ \(|discover \w+:|feeds \w+:/.test(l)).length,
        boardsToday: new Set(today.map((l) => /discover (\w+)|feeds (\w+)|🌐 (Naukri): "/.exec(l)).filter(Boolean).map((m) => m[1] || m[2] || m[3])).size };
    },

    'GET /api/jobs/memory': () => ({
      answers: q('SELECT id, question, answer, source, uses, updated_at FROM questions WHERE answer IS NOT NULL ORDER BY updated_at DESC'),
    }),

    'POST /api/jobs/action': async ({ body }) => {
      if (!['answer', 'pause', 'resume', 'live', 'dry', 'skip', 'queue', 'applied', 'forget'].includes(body.action)) throw fail(400, 'Unknown action.');
      return agent({ action: body.action, id: body.id, answer: body.answer });
    },
  },
};
