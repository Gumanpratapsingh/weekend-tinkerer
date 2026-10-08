// Helpers shared by the job sources, plus the cheap (no-LLM) filters every job passes before scoring.
import { config } from '../core.mjs';

export const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

export async function getJson(url, opts = {}) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(30000), ...opts });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}
export async function getText(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-IN,en;q=0.9' }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.text();
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
export const decode = (s) => String(s ?? '').replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENTITIES[e] ?? m);
export const htmlToText = (html) => decode(decode(String(html ?? ''))          // Greenhouse double-escapes
  .replace(/<(br|\/p|\/li|\/h\d|\/div)[^>]*>/gi, '\n').replace(/<li[^>]*>/gi, '• ').replace(/<[^>]+>/g, ''))
  .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

const FOREIGN = /\b(us|usa|u\.s\.|united states|canada|uk|united kingdom|england|ireland|europe|eu|emea|germany|france|spain|portugal|netherlands|poland|latam|brazil|mexico|americas|australia|singapore|japan|israel|uae|dubai|[a-z]{2}\s*,\s*usa|new york|san francisco|london|berlin|toronto)\b/;

// Where a job sits in the owner's preference: north (Gurugram/NCR/North India), remote (open to India),
// other (another Indian city, allowed but less preferred), or null (not workable from India).
export function locationTier(location, description = '') {
  const L = config().locations;
  const loc = String(location || '').toLowerCase();
  if (L.preferred.some((k) => loc.includes(k))) return 'north';
  if (L.remote_ok.some((k) => loc.includes(k))) {
    if (/\b(india|apac|asia|anywhere|worldwide|global)\b/.test(loc)) return 'remote';
    if (FOREIGN.test(loc)) return null;                // "Remote - US", "Remote (Germany)"...
    const text = `${loc} ${String(description).slice(0, 3000).toLowerCase()}`;
    return /\b(india|apac|anywhere in the world|worldwide)\b/.test(text) || !L.remote_blocked.some((k) => text.includes(k)) ? 'remote' : null;
  }
  if (L.other_cities.some((k) => loc.includes(k)) || /\bindia\b/.test(loc)) return 'other';
  return null;
}
export const locationOk = (location, description) => locationTier(location, description) !== null;

export function titleOk(title) {
  const c = config();
  const t = ` ${String(title).toLowerCase()} `;
  if (c.title_exclude.some((k) => t.includes(k))) return false;
  return c.title_include.some((k) => t.includes(k));
}

// Rough experience gate from the JD text: skip roles that clearly want far more years than we have.
export function experienceOk(text) {
  const have = config().experience_years;
  const m = [...String(text).matchAll(/(\d{1,2})\s*(?:\+|-|–|to)?\s*(\d{1,2})?\s*\+?\s*(?:years|yrs)/gi)];
  const mins = m.map((x) => +x[1]).filter((n) => n > 0 && n < 25);
  if (!mins.length) return true;
  return Math.min(...mins) <= have + 1;
}
