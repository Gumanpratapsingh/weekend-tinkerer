// Per-person settings the person changes themselves in Cupboard (Settings → 💼 Job agent). Values live in this agent's
// kv (switches keep their old keys, so chat commands like "pause" or "ncr off" and these toggles stay in step), on top of
// config.json. Every value is range-checked here: the page can't push anything outside these limits.
import { config } from './core.mjs';
import { getKv, setKv } from './db.mjs';

const num = () => JSON.parse(getKv('settings', '{}'));
// Switches: the kv key and whether "on" is stored as '1' (flag) or as the absence of an "off" flag.
const SWITCHES = {
  applying: { kv: 'paused', on: '0', label: 'Apply automatically', help: 'Off = the agent still searches and sends you links, but never applies.' },
  ncr: { kv: 'ncr_off', on: '0', label: 'Delhi NCR watch', help: 'Gurgaon/Noida/Delhi jobs come to your 📍 chat as links; the agent never applies to them.' },
  ncr_night: { kv: 'ncr_night_off', on: '0', label: 'Search NCR at night', help: 'Only sites that don\'t use your accounts (company career sites, LinkedIn public search). Naukri rests 23:00-05:00.' },
  ncr_referrals: { kv: 'ncr_ref_off', on: '0', label: 'Automatic referral drafts (NCR)', help: 'Finds ex-colleagues, alumni and senior people at NCR companies. Each draft waits for your Send.' },
};
const NUMBERS = {
  min_score: { label: 'Auto-apply above (match %)', min: 40, max: 95, def: () => config().min_score },
  ncr_min_score: { label: 'Send NCR links above (match %)', min: 30, max: 95, def: () => config().ncr?.min_score ?? 50 },
  ncr_ref_every_h: { label: 'Referral search every (hours)', min: 2, max: 24, def: () => 2 },
  cap_naukri: { label: 'Naukri applications per day', min: 0, max: 50, def: () => config().daily_caps?.naukri ?? 25 },
  cap_linkedin: { label: 'LinkedIn Easy Apply per day', min: 0, max: 25, def: () => config().daily_caps?.linkedin ?? 10 },
  cap_ats: { label: 'Company-site applications per day', min: 0, max: 60, def: () => config().daily_caps?.ats ?? 20 },
};

/** A number setting (the person's value, else config.json's). */
export const setting = (key) => { const v = num()[key]; return v == null ? NUMBERS[key].def() : v; };
/** A switch (true = on). */
export const switchOn = (key) => getKv(SWITCHES[key].kv, SWITCHES[key].on) === SWITCHES[key].on;
/** Daily caps with the person's own limits over config.json's. */
export const caps = () => ({ ...config().daily_caps, naukri: setting('cap_naukri'), linkedin: setting('cap_linkedin'), ats: setting('cap_ats') });

export function getSettings() {
  return {
    switches: Object.entries(SWITCHES).map(([key, s]) => ({ key, label: s.label, help: s.help, on: switchOn(key) })),
    numbers: Object.entries(NUMBERS).map(([key, n]) => ({ key, label: n.label, min: n.min, max: n.max, value: setting(key) })),
  };
}

export function setSettings(patch = {}) {
  const cur = num();
  for (const [key, v] of Object.entries(patch || {})) {
    if (SWITCHES[key] && typeof v === 'boolean') { const s = SWITCHES[key]; setKv(s.kv, v ? s.on : (s.on === '0' ? '1' : '0')); }
    else if (NUMBERS[key]) {
      const n = Math.round(Number(v));
      if (!Number.isFinite(n)) throw new Error(`${NUMBERS[key].label}: not a number`);
      cur[key] = Math.min(NUMBERS[key].max, Math.max(NUMBERS[key].min, n));
    } else throw new Error(`unknown setting ${key}`);
  }
  setKv('settings', JSON.stringify(cur));
  return getSettings();
}
