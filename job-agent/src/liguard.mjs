// LinkedIn guard: the agent runs round the clock, and backs off by itself when the account looks like it is in trouble. Each account on its own.
// A sign LinkedIn is unhappy pauses everything at once; ordinary errors do only when they pile up. The pause is random and grows if it keeps happening.
import { getKv, setKv } from './db.mjs';
import { config, istHour, istDate, activity } from './core.mjs';
import { tell } from './whatsapp.mjs';

const TASK = /^(linkedin_|apply_linkedin$)/;
const TROUBLE = /checkpoint|authwall|session_expired|too many requests|\b429\b|restricted|temporarily (limited|blocked)|unusual activity|security (check|verification)|captcha|rate.?limit/i;
const NOT_LINKEDIN = /ERR_INTERNET|ERR_NETWORK|ERR_NAME|EAI_AGAIN|ENOTFOUND|ECONNRE|AI busy|All LLM|task .* took over/i;   // our connection or our own limits, not the account
const SOFT_LIMIT = 5, SOFT_WINDOW = 30 * 60e3;

export const linkedinPaused = () => Number(getKv('li_pause_until', 0)) > Date.now();
export const linkedinHours = () => { const h = istHour(); return !!config().linkedin_always_on || (h >= 9 && h < 21); };

function pause(why) {
  if (linkedinPaused()) return;
  const key = `li_trips:${istDate()}`, trips = Number(getKv(key, 0)) + 1;
  setKv(key, trips);
  const [from, to] = trips === 1 ? [2, 3] : trips === 2 ? [4, 6] : [12, 18];
  const hours = from + Math.random() * (to - from);
  setKv('li_pause_until', Date.now() + hours * 3600e3);
  setKv('li_soft', '[]');
  const text = `LinkedIn paused for ${Math.floor(hours)} h ${Math.round((hours % 1) * 60)} min (pause ${trips} today): ${String(why).slice(0, 140)}`;
  activity(`🛡️ ${text}`);
  tell(`🛡️ ${text}. It resumes by itself.`);
}

// Called with the outcome of every browser task.
export function noteLinkedin(name, { error = null, result = null } = {}) {
  if (!TASK.test(name)) return;
  const text = error ? String(error) : `${result?.status || ''} ${result?.reason || ''}`;
  if (error && NOT_LINKEDIN.test(text)) return;
  if (TROUBLE.test(text)) return pause(text);
  if (!error) return;
  const now = Date.now();
  const soft = [...JSON.parse(getKv('li_soft', '[]')).filter((t) => now - t < SOFT_WINDOW), now];
  setKv('li_soft', JSON.stringify(soft));
  if (soft.length >= SOFT_LIMIT) pause(`${soft.length} errors in 30 minutes, the last: ${text}`);
}
