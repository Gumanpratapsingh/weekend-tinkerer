// Guards against a failure that repeats unnoticed (2026-10-19/20: a saved answer that was really Naukri's "Skip this question"
// button looped the same question for a day and cost applications; the nightly review had flagged it but nobody acted).
//  1) saved answers that are button labels, not answers, are deleted;
//  2) the same failure many times in a few hours sends ONE urgent alert to the owner, naming it, so it is looked at the same day.
import { run, all, getKv, setKv } from './db.mjs';
import { log, PERSON, istDate } from './core.mjs';
import { tell } from './whatsapp.mjs';

// What a button says is never what a form is asking: also refused when saving an answer (answers.mjs remember).
export const CONTROL_ANSWER = /^\s*(skip( this question)?|save|submit|next|continue|apply|cancel|close|back)\s*$/i;
// Waits that are expected and have their own alerts (a person must act), not bugs.
const EXPECTED = /captcha|needs an account|company site|applies on|NCR job|security code|session|quota|limit|already applied|closed|no longer/i;

export function watchdog() {
  const bad = run("DELETE FROM questions WHERE source = 'derived' AND lower(trim(answer)) IN ('skip this question','skip','save','submit','next','continue','apply','cancel','close','back')").changes;
  if (bad) log(`watchdog: deleted ${bad} saved answer(s) that were button labels, not answers`);
  const rows = all(`SELECT a.reason, a.status, count(*) n, count(DISTINCT a.job_id) jobs, group_concat(DISTINCT substr(j.title, 1, 40)) titles
    FROM attempts a JOIN jobs j ON j.id = a.job_id
    WHERE a.at > ? AND a.status IN ('failed','error','manual') AND a.reason IS NOT NULL AND a.reason != ''
    GROUP BY substr(a.reason, 1, 60) HAVING n >= 8`, Date.now() - 3 * 3600e3).filter((r) => !EXPECTED.test(r.reason));
  for (const r of rows) {
    const key = `watchdog:${istDate()}:${r.reason.slice(0, 60)}`;
    if (getKv(key)) continue;
    setKv(key, '1');
    tell(`🔁 Same problem ${r.n} times in 3 hours${PERSON ? ` (${PERSON}'s agent)` : ''}: "${r.reason.slice(0, 120)}" on ${r.jobs} job(s), e.g. ${String(r.titles || '').slice(0, 120)}. `
      + `The agent keeps hitting this; it needs a fix, not more retries.`, { urgent: true, toOwner: !!PERSON });
  }
}
