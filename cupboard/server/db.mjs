// SQLite storage for Cupboard (node:sqlite, no dependencies). Everything lives on the phone in ~/cupboard/data.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const HOME = homedir();
export const DATA = join(HOME, 'cupboard', 'data');
export const MEDIA = join(DATA, 'media');
mkdirSync(MEDIA, { recursive: true, mode: 0o700 });

export const db = new DatabaseSync(join(DATA, 'cupboard.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL, salt TEXT, hash TEXT,
  role TEXT NOT NULL DEFAULT 'friend', active INTEGER NOT NULL DEFAULT 1, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS invites (token TEXT PRIMARY KEY, created_by INTEGER, role TEXT NOT NULL DEFAULT 'friend',
  expires INTEGER NOT NULL, used_by INTEGER);
CREATE TABLE IF NOT EXISTS convs (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, name TEXT, created_by INTEGER, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS members (conv_id INTEGER NOT NULL, user_id INTEGER NOT NULL, last_read INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conv_id, user_id));
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY, conv_id INTEGER NOT NULL, user_id INTEGER NOT NULL, kind TEXT NOT NULL,
  text TEXT, media TEXT, duration REAL, extra TEXT, created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS messages_conv ON messages (conv_id, id);
CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, user_id INTEGER NOT NULL, sub TEXT NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
`);

export const one = (sql, ...a) => db.prepare(sql).get(...a);
export const all = (sql, ...a) => db.prepare(sql).all(...a);
export const run = (sql, ...a) => db.prepare(sql).run(...a);
export const getKv = (k, d = null) => one('SELECT v FROM kv WHERE k = ?', k)?.v ?? d;
export const setKv = (k, v) => run('INSERT INTO kv(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, String(v));

// The server itself is a user ("S20"), so its messages look like any other chat.
if (!one("SELECT 1 FROM users WHERE role = 'bot'")) {
  run("INSERT INTO users(username, name, role, created) VALUES('s20', 'S20', 'bot', ?)", Date.now());
}
export const botId = () => one("SELECT id FROM users WHERE role = 'bot'").id;
export const owner = () => one("SELECT * FROM users WHERE role = 'owner' AND active = 1");
