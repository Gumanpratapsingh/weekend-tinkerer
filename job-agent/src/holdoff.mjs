// "Too many requests" (HTTP 429) anywhere: stop asking that site for 12-18 hours so the account/IP is never pushed into a block.
// Per site, saved in kv so it survives restarts. Clear early with: DELETE FROM kv WHERE key LIKE 'holdoff:%'
// (and remove the site from SHARED_FILE for an IP-wide hold).
//
// IP-wide holds (`shared`): logged-out fetches (LinkedIn's guest job search, public feeds) are limited per IP, and every agent on
// the machine (owner, Vertika, prod users) shares one home IP. Until 2026-11-25 each agent held off on its own, so their 12-18 h
// holds ran staggered, one agent or another asked LinkedIn every few hours, and from 16 Nov every hold ended in a fresh 429 within
// minutes: LinkedIn search found almost nothing for 9 days. Now a shared hold in SHARED_FILE stops all of them together, and a 429
// that comes back soon after a hold ends doubles the next one (up to 72 h), so the IP gets a real rest.
import { readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { getKv, setKv } from './db.mjs';
import { log } from './core.mjs';

// A directory every agent user can write (group jobshare, setgid, see linux/install.sh). Missing on the S20: then holds stay per agent.
export const SHARED_DIR = process.env.JOBAGENT_SHARED_DIR || '/var/lib/jobagent-shared';
const SHARED_FILE = () => join(SHARED_DIR, 'holdoff.json');
const RECENT = 6 * 3600e3, MAX_HOURS = 72;

function readShared() {
  try { return JSON.parse(readFileSync(SHARED_FILE(), 'utf8')) || {}; } catch { return {}; }
}
function writeShared(all) {
  const tmp = `${SHARED_FILE()}.${process.pid}.tmp`;
  try { writeFileSync(tmp, JSON.stringify(all)); chmodSync(tmp, 0o664); renameSync(tmp, SHARED_FILE()); return true; }
  catch { return false; }
}

const local = (site) => ({ until: Number(getKv(`holdoff:${site}`, 0)), streak: Number(getKv(`holdoff_streak:${site}`, 0)) });
export const heldUntil = (site) => Math.max(local(site).until, Number(readShared()[site]?.until || 0));
export const held = (site) => heldUntil(site) > Date.now();

// How long the next hold is: 12-18 h, doubled for each 429 that came back within 6 h of the previous hold ending.
export function nextHold(prev, now = Date.now(), rnd = Math.random()) {
  const streak = prev.until && now - prev.until < RECENT ? (prev.streak || 0) + 1 : 0;
  return { streak, hours: Math.min(MAX_HOURS, (12 + rnd * 6) * 2 ** streak) };
}

export function holdOff(site, why = '429 too many requests', { shared = false } = {}) {
  if (held(site)) return;
  const all = shared ? readShared() : {};
  const mine = local(site), theirs = all[site] || {};
  const prev = (theirs.until || 0) > mine.until ? theirs : mine;
  const { streak, hours } = nextHold(prev);
  const until = Date.now() + hours * 3600e3;
  setKv(`holdoff:${site}`, until);
  setKv(`holdoff_streak:${site}`, streak);
  const wide = shared && writeShared({ ...all, [site]: { until, streak, why: String(why).slice(0, 120), at: Date.now() } });
  log(`${site}: ${why} — not asking again for ${hours.toFixed(1)} h${streak ? ` (429 again soon after the last hold, ${streak}× longer)` : ''}${wide ? ', for every agent on this machine' : ''}`);
}
