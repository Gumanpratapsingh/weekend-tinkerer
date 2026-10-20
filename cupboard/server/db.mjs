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
CREATE TABLE IF NOT EXISTS pins (conv_id INTEGER NOT NULL, msg_id INTEGER NOT NULL, by INTEGER, at INTEGER NOT NULL, PRIMARY KEY (conv_id, msg_id));
-- "Together": shared lists and a shared calendar. Each belongs to a chat; its members share it.
CREATE TABLE IF NOT EXISTS lists (id INTEGER PRIMARY KEY, conv_id INTEGER NOT NULL, title TEXT NOT NULL, emoji TEXT,
  created_by INTEGER, created INTEGER NOT NULL, updated INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS list_items (id INTEGER PRIMARY KEY, list_id INTEGER NOT NULL, text TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0,
  done_by INTEGER, done_at INTEGER, created_by INTEGER, created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS list_items_list ON list_items (list_id, id);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, conv_id INTEGER NOT NULL, title TEXT NOT NULL, starts INTEGER NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 0, remind_at INTEGER, for_all INTEGER NOT NULL DEFAULT 1, kind TEXT NOT NULL DEFAULT 'event',
  repeat TEXT, created_by INTEGER, created INTEGER NOT NULL, sent INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS events_due ON events (sent, remind_at);
-- Trusted devices: only browsers approved by someone already in reach the app at all (cookie cbd; the hash is stored).
CREATE TABLE IF NOT EXISTS devices (id INTEGER PRIMARY KEY, hash TEXT UNIQUE NOT NULL, name TEXT, user_id INTEGER, added_by INTEGER,
  created INTEGER NOT NULL, seen INTEGER);
-- Wedding planner (Together → Wedding): one wedding per chat; its members plan it. data = {partner1, partner2, date, city, budget, plan}
CREATE TABLE IF NOT EXISTS weddings (id INTEGER PRIMARY KEY, conv_id INTEGER NOT NULL UNIQUE, data TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS w_functions (id INTEGER PRIMARY KEY, wedding_id INTEGER NOT NULL, name TEXT NOT NULL, starts INTEGER, venue TEXT, map TEXT,
  note TEXT, sort INTEGER NOT NULL DEFAULT 0, event_id INTEGER, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS w_tasks (id INTEGER PRIMARY KEY, wedding_id INTEGER NOT NULL, text TEXT NOT NULL, phase TEXT, owner TEXT, done INTEGER NOT NULL DEFAULT 0,
  done_by INTEGER, done_at INTEGER, sort INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS w_guests (id INTEGER PRIMARY KEY, wedding_id INTEGER NOT NULL, name TEXT NOT NULL, side TEXT, grp TEXT, phone TEXT,
  adults INTEGER NOT NULL DEFAULT 1, kids INTEGER NOT NULL DEFAULT 0, invited TEXT NOT NULL DEFAULT '[]', rsvp TEXT NOT NULL DEFAULT '{}', meal TEXT, note TEXT,
  message TEXT, token TEXT UNIQUE, responded INTEGER, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS w_vendors (id INTEGER PRIMARY KEY, wedding_id INTEGER NOT NULL, name TEXT NOT NULL, category TEXT, phone TEXT, status TEXT NOT NULL DEFAULT 'considering',
  quote INTEGER NOT NULL DEFAULT 0, paid INTEGER NOT NULL DEFAULT 0, due INTEGER, note TEXT, event_id INTEGER, created INTEGER NOT NULL);
`);
// Per-person chat settings (added later): mute until a time (0 = not muted), archived.
// users.admin: the owner's powers (invites, reset links, people, devices, monitor) without being the owner, whose own
// S20 bot and job agent stay the owner's.
for (const sql of ['ALTER TABLE members ADD COLUMN muted_until INTEGER NOT NULL DEFAULT 0', 'ALTER TABLE members ADD COLUMN archived INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE users ADD COLUMN admin INTEGER NOT NULL DEFAULT 0']) {
  try { db.exec(sql); } catch { /* column already there */ }
}

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
