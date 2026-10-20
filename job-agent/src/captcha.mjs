// CAPTCHA handoff from Cupboard: the job's form is filled on the laptop's browser and the person finishes it on the live
// page (same screen/tap/type plumbing as the sign-in page): they solve the CAPTCHA and press Submit themselves.
// Nothing here reads or solves a CAPTCHA.
import { existsSync } from 'node:fs';
import { AGENT_URL, log, logError, privateProfile } from './core.mjs';
import { one, run, getKv, setKv } from './db.mjs';
import { browserTask } from './browser.mjs';
import { tell } from './whatsapp.mjs';

const label = (j) => `${j.title} @ ${j.company}`;

// A card in the person's chat with a link to the live page. Called when a job lands on the CAPTCHA list.
export async function captchaCard(job, { chat = null, images = null } = {}) {
  let link = null;
  try {
    const r = await fetch('http://127.0.0.1:8086/signin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(5000),
      body: JSON.stringify({ to: privateProfile().cupboard_user, agent: AGENT_URL, site: 'captcha', job: job.id }) });
    link = (await r.json()).path;
  } catch (e) { log(`captcha link: ${e.message}`); }
  const text = `🧩 ${label(job)} needs a CAPTCHA. ${link ? 'Tap "Fill and open": I fill the form, you type the CAPTCHA and press Submit.\nOn the Mac it also opens by itself.' : 'Run ./scripts/finish.sh on the Mac, solve it, press Submit.'}`;
  return tell(text, { chat, images, ...(link ? { refKind: 'captcha', refId: job.id, link: { label: 'Fill and open', path: link } } : {}) });
}

let live = null;                                      // { id, at }: one handoff at a time (one browser slot)
export const liveCaptcha = () => (live && Date.now() - live.at < 20 * 60e3 ? live.id : null);

// The page was opened: fill the form (waits for a free browser), report back here when it ends.
export async function startCaptcha(id) {
  const job = one('SELECT * FROM jobs WHERE id = ?', String(id));
  if (!job) return { ok: false, error: 'That job is gone.' };
  if (['applied', 'interview'].includes(job.status)) { setKv('captcha_done', job.id); return { ok: true }; }
  if (liveCaptcha()) return { ok: true, already: true };
  live = { id: job.id, at: Date.now() };
  setKv('captcha_done', '');
  const resume = job.resume_path && existsSync(job.resume_path) ? job.resume_path : null;
  browserTask('captcha', { job, resume }, 20 * 60e3).then((r) => {
    if (r.applied) {
      run("UPDATE jobs SET status = 'applied', applied_at = ?, status_note = 'applied by you (CAPTCHA)' WHERE id = ?", Date.now(), job.id);
      setKv('captcha_done', job.id);
      tell(`✅ Applied: ${label(job)}.`);
    } else tell(`${label(job)}: no confirmation seen (${r.reason || 'closed'}). It stays on the CAPTCHA list.`);
  }).catch((e) => { logError('captcha', e, { job: job.id }); tell(`The CAPTCHA page stopped (${String(e.message).slice(0, 80)}). The job stays on the CAPTCHA list.`); })
    .finally(() => { live = null; });
  return { ok: true };
}
export const captchaDone = (id) => getKv('captcha_done') === id;
