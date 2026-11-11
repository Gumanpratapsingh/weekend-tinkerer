// Daily: ask the LLM for ~10 more well-known MNCs / good startups hiring engineers in India, send them to the owner in Cupboard,
// and add the approved ones to the top-company list (kv top_extra, read by companies.mjs) so the apply queue serves them first.
import { llm, activity, istDate } from './core.mjs';
import { getKv, setKv } from './db.mjs';
import { tell, cardDone } from './whatsapp.mjs';
import { isTopCompany, approvedCompanies } from './companies.mjs';

const list = (k) => { try { return JSON.parse(getKv(k, '[]')); } catch { return []; } };
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export async function suggestCompanies(n = 10) {
  const seen = [...list('top_extra'), ...list('top_rejected')];
  const out = await llm([
    { role: 'system', content: 'You suggest employers for a software engineer in India (backend Java/Spring, full stack, some AI) who wants interviews. Only real, well-known companies that hire engineers in India: big MNCs, global product companies, GCCs, and well-funded or well-regarded startups. No staffing firms, no tiny unknown firms, no invented names. Return JSON: {"companies":["Name",...]}' },
    { role: 'user', content: `Suggest ${n * 2} companies. Do NOT repeat any of these: ${seen.slice(-200).join(', ')}.` },
  ], { json: true, maxTokens: 500, temperature: 0.8, why: 'suggesting top companies' });
  const names = [...new Set((out.companies || []).map((c) => String(c).trim()).filter((c) => c && c.length < 40))]
    .filter((c) => !isTopCompany(c) && !seen.some((s) => norm(s) === norm(c))).slice(0, n);
  if (!names.length) return null;
  const id = Date.now();
  setKv(`topco:${id}`, JSON.stringify(names));
  tell(`🏢 ${names.length} companies to add to your top list (applied first from now on):\n${names.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n\nTap ✓ Add all, or reply with the numbers to add (e.g. "1,3,7"). ✕ Skip rejects them all.`, { refKind: 'topco', refId: id });
  activity(`🏢 sent ${names.length} company suggestions for approval`);
  return id;
}

export function decideCompanies(id, text) {
  const names = list(`topco:${id}`);
  if (!names.length) return 'That company list was already handled.';
  const t = String(text).trim().toLowerCase();
  let pick;
  if (/^(ok|okay|yes|add|all|👍)$/.test(t)) pick = names.map((_, i) => i);
  else if (/^(no|skip|none|reject)$/.test(t)) pick = [];
  else { pick = [...t.matchAll(/\d+/g)].map((m) => +m[0] - 1).filter((i) => i >= 0 && i < names.length); if (!pick.length) return 'Reply ok, skip, or the numbers to add, e.g. 1,3,7.'; }
  const add = pick.map((i) => names[i]), rest = names.filter((_, i) => !pick.includes(i));
  setKv('top_extra', JSON.stringify([...new Set([...list('top_extra'), ...add])]));
  setKv('top_rejected', JSON.stringify([...list('top_rejected'), ...rest].slice(-300)));
  setKv(`topco:${id}`, '[]');
  cardDone('topco', id, add.length ? `Added ${add.length}` : 'Skipped');
  return add.length ? `✓ Added to the top list: ${add.join(', ')}.${rest.length ? ` Skipped: ${rest.join(', ')}.` : ''}` : '✓ Skipped them all; I won\'t suggest those again.';
}

// Once a day, late morning IST, owner only.
export async function dailySuggest() {
  const h = new Date(Date.now() + 5.5 * 3600e3).getUTCHours();
  if (h < 11 || getKv('topco_day') === istDate()) return;
  setKv('topco_day', istDate());
  await suggestCompanies(10);
}
export { approvedCompanies };
