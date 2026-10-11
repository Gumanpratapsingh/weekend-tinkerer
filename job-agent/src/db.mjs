// SQLite memory for the agent (node:sqlite, no dependencies). One file: data/agent.db.
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { DATA } from './core.mjs';

export const db = new DatabaseSync(join(DATA, 'agent.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,                 -- "<source>:<external id>"
  source TEXT NOT NULL,                -- naukri | linkedin | greenhouse | lever | ashby | remotive | arbeitnow | hn
  url TEXT, apply_url TEXT, apply_type TEXT,
  title TEXT, company TEXT, location TEXT, description TEXT, posted_at TEXT,
  dedupe TEXT,                         -- normalised company|title, so one role found on two boards is applied to once
  found_at INTEGER NOT NULL,
  track TEXT,                          -- backend | ai
  score INTEGER, score_reasons TEXT,
  status TEXT NOT NULL DEFAULT 'new',  -- new, filtered, scored, queued, applying, ready (dry run ok), needs_answer, applied, manual, claimed (owner applying by hand), failed, skipped, interview, rejected
  status_note TEXT,
  resume_path TEXT, applied_at INTEGER, attempts INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS jobs_dedupe ON jobs(dedupe);

-- Every question any form or recruiter has asked, and the owner's answer. This is the agent's memory.
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY,
  question TEXT NOT NULL,
  norm TEXT NOT NULL UNIQUE,           -- lowercased, punctuation stripped
  answer TEXT,                         -- NULL until the owner answers
  kind TEXT DEFAULT 'text',            -- text | number | yesno | choice
  options TEXT,                        -- JSON array for choice questions
  source TEXT,                         -- where it was first seen
  uses INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER
);

-- Questions sent to the owner on WhatsApp and waiting for a reply.
CREATE TABLE IF NOT EXISTS asks (
  id INTEGER PRIMARY KEY,
  question_id INTEGER NOT NULL REFERENCES questions(id),
  job_id TEXT, thread_id TEXT,
  wa_msg_id TEXT, asked_at INTEGER NOT NULL,
  status TEXT DEFAULT 'open'           -- open | answered
);

CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY,                 -- Message-ID
  thread_id TEXT, job_id TEXT,
  direction TEXT,                      -- in | out
  from_addr TEXT, to_addr TEXT, subject TEXT, body TEXT,
  category TEXT,                       -- interview | question | assessment | rejection | offer | other
  at INTEGER NOT NULL
);

-- Replies the agent wants to send; nothing is sent until the owner says ok on WhatsApp.
CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY,
  email_id TEXT NOT NULL, body TEXT NOT NULL,
  status TEXT DEFAULT 'waiting',       -- waiting (on owner answers) | pending (on approval) | sent | discarded
  wa_msg_id TEXT, created_at INTEGER NOT NULL, sent_at INTEGER
);

-- Every application attempt (success or not): what happened, how long, what was filled/left, evidence paths.
CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY, job_id TEXT NOT NULL, at INTEGER NOT NULL, ms INTEGER, task TEXT,
  status TEXT, reason TEXT, shot TEXT, filled INTEGER, unknown INTEGER, result TEXT
);
CREATE INDEX IF NOT EXISTS attempts_job ON attempts(job_id);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, kind TEXT, text TEXT);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
`);

// Later columns (added in place on existing databases).
for (const col of ['form_answers TEXT', 'priority INTEGER DEFAULT 0']) { try { db.exec(`ALTER TABLE jobs ADD COLUMN ${col}`); } catch { /* already there */ } }

export const one = (sql, ...p) => db.prepare(sql).get(...p);
export const all = (sql, ...p) => db.prepare(sql).all(...p);
export const run = (sql, ...p) => db.prepare(sql).run(...p);

export const getKv = (k, d = null) => one('SELECT value FROM kv WHERE key = ?', k)?.value ?? d;
export const setKv = (k, v) => run('INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, String(v));
export const event = (kind, text) => run('INSERT INTO events(at, kind, text) VALUES(?, ?, ?)', Date.now(), kind, text);

export const norm = (s) => String(s).toLowerCase().replace(/\*|\(required\)|[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
export const dedupeKey = (company, title) =>
  `${norm(company).replace(/\b(pvt|private|ltd|limited|inc|llp|technologies|technology|solutions)\b/g, '').trim()}|${norm(title)}`;
