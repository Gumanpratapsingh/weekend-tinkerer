// "Too many requests" (HTTP 429) anywhere: stop asking that site for 12-18 hours so the account/IP is never pushed into a block.
// Per site, saved in kv so it survives restarts. Clear early with: DELETE FROM kv WHERE key LIKE 'holdoff:%'.
import { getKv, setKv } from './db.mjs';
import { log } from './core.mjs';

export const heldUntil = (site) => Number(getKv(`holdoff:${site}`, 0));
export const held = (site) => heldUntil(site) > Date.now();
export function holdOff(site, why = '429 too many requests') {
  if (held(site)) return;
  const hours = 12 + Math.random() * 6;
  setKv(`holdoff:${site}`, Date.now() + hours * 3600e3);
  log(`${site}: ${why} — not asking again for ${hours.toFixed(1)} h`);
}
