// Referral outreach: for target companies (owner's list + companies with an 80%+ match), find people on LinkedIn
// (SRM alumni first), draft a short note naming the exact job, and ask the owner to approve EVERY message.
// Approved invites go out slowly (10/day, spaced, 9:00-21:00 IST). When someone accepts, a referral request with the
// resume follows: by email if they publish one, else a LinkedIn message, again only after approval.
import { config, log, logError, activity, master, istHour, istDate } from './core.mjs';
import { one, all, run, getKv, setKv } from './db.mjs';
import { browserTask } from './browser.mjs';
import { tell } from './whatsapp.mjs';

const R = () => config().referrals || {};
const now = () => Date.now();
const set = (id, fields) => {
  const keys = Object.keys(fields);
  run(`UPDATE referrals SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...keys.map((k) => fields[k]), now(), id);
};

// Owner's list + companies where a job scored >= auto_min_score.
export function targetCompanies() {
  const list = new Set((R().companies || []).map((c) => c.trim()).filter(Boolean));
  for (const r of all('SELECT DISTINCT company FROM jobs WHERE score >= ? AND company IS NOT NULL', R().auto_min_score || 80)) list.add(r.company);
  return [...list];
}

// Best open job at a company from what the agent already found (needs a link to cite in the note).
function jobAt(company) {
  const key = `%${company.toLowerCase().replace(/ (inc|ltd|llp|pvt|private|limited|group|global tech)\.?$/g, '')}%`;
  return one(`SELECT id, title, url, score FROM jobs WHERE lower(company) LIKE ? AND score >= 65
    AND status NOT IN ('skipped','filtered','rejected') ORDER BY score DESC, found_at DESC LIMIT 1`, key);
}

function note(person, job, company, alumni) {
  const first = String(person).split(/\s+/)[0];
  const m = master();
  const intro = alumni ? `fellow SRM alum here (B.Tech CS '24)` : `I'm a backend engineer`;
  const role = job ? `the ${job.title} role${job.id ? ` (job ${String(job.id).split(':').pop()})` : ''}` : `a backend/AI engineering role`;
  // LinkedIn invite notes are capped at 300 characters.
  return `Hi ${first}, ${intro}. ${alumni ? "I'm a" : 'I build'} Java/Spring Boot payment systems at ${m.experience[0].org} (2+ yrs) and LLM apps. I'm applying for ${role} at ${company}. Would you be open to referring me? Happy to share my resume. Thanks! – ${m.name.split(' ')[0]}`.slice(0, 300);
}

function followupText(r) {
  const first = String(r.person).split(/\s+/)[0];
  const m = master();
  return `Thanks for connecting, ${first}! I'd be grateful for a referral for ${r.job_title ? `the ${r.job_title} role` : 'a backend/AI role'} at ${r.company}${r.job_url ? `: ${r.job_url}` : ''}.\n\n`
    + `Quick summary: ${m.experience[0].title} at ${m.experience[0].org}, 2+ years building Java/Spring Boot payment systems for 50+ banks on AWS, `
    + `plus LLM projects (a real-time AI phone assistant, an autonomous job agent). Resume attached. Happy to answer anything. Thank you!\n– ${m.name}, ${m.contact.phone}`;
}

// 1) Find people at the next target company and queue drafts for approval (a few companies per run).
export async function prospect() {
  const done = new Set(all('SELECT DISTINCT company FROM referrals').map((r) => r.company.toLowerCase()));
  const waiting = one("SELECT count(*) n FROM referrals WHERE stage = 'drafted'").n;
  if (waiting >= 15) return;                                    // don't flood the owner with drafts
  for (const company of targetCompanies().filter((c) => !done.has(c.toLowerCase())).slice(0, 2)) {
    const job = jobAt(company);
    let people;
    try { people = (await browserTask('linkedin_people', { company, school: R().school || 'SRM' }, 10 * 60e3)).people || []; }
    catch (e) { logError('referrals people', e, { company }); continue; }
    const picks = people.filter((p) => p.url && !one('SELECT 1 FROM referrals WHERE profile = ?', p.url))
      .sort((a, b) => b.alumni - a.alumni).slice(0, R().people_per_company || 3);
    activity(`🤝 Referrals: ${company}: found ${people.length} people, drafting ${picks.length}${job ? ` (job: ${job.title})` : ' (no matching job yet)'}`);
    if (!picks.length) { run('INSERT OR IGNORE INTO referrals(company, stage, reason, created_at) VALUES(?,?,?,?)', company, 'skipped', 'nobody found', now()); continue; }
    for (const p of picks) {
      const text = note(p.name, job, company, p.alumni);
      run(`INSERT OR IGNORE INTO referrals(company, job_id, job_title, job_url, person, headline, profile, alumni, stage, note, created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`, company, job?.id || null, job?.title || null, job?.url || null, p.name, p.headline, p.url, p.alumni ? 1 : 0, 'drafted', text, now());
      const id = one('SELECT id FROM referrals WHERE profile = ?', p.url).id;
      if (p.degree === '1st') { set(id, { stage: 'accepted', reason: 'already a connection' }); draftFollowup(id); continue; }
      tell(`🤝 Referral request #${id}: ${p.name}${p.alumni ? ' (SRM alum)' : ''}\n${p.headline || ''}\n${p.url}\n\nNote:\n${text}\n\n— Send, Skip, or type your own note to send instead.`,
        { refKind: 'referral', refId: id });
    }
  }
}

// Owner's reply on a draft (from Cupboard / commands).
export function decide(id, text) {
  const r = one('SELECT * FROM referrals WHERE id = ?', id);
  if (!r) return 'No such referral request.';
  const t = String(text).trim();
  const followup = r.stage === 'followup_drafted';
  if (/^(no|skip|discard|cancel)$/i.test(t)) { set(id, { stage: 'skipped', reason: 'skipped by you' }); return `Skipped ${r.person}.`; }
  const custom = /^(ok|okay|yes|send|👍)$/i.test(t) ? null : t;
  if (followup) { set(id, { stage: 'followup_approved', ...(custom ? { followup: custom } : {}) }); return `✓ Follow-up to ${r.person} approved; it goes out shortly.`; }
  if (r.stage !== 'drafted') return `That request is already ${r.stage}.`;
  set(id, { stage: 'approved', ...(custom ? { note: custom.slice(0, 300) } : {}) });
  return `✓ Approved: invite to ${r.person} goes out within the next send slot.`;
}

// 2) Send approved invites / follow-ups, slowly.
function slotOpen() {
  const c = R(); const h = istHour();
  if (h < (c.hours || [9, 21])[0] || h >= (c.hours || [9, 21])[1]) return false;
  if (Number(getKv('ref_backoff_until', 0)) > now()) return false;
  if (now() < Number(getKv('ref_next_at', 0))) return false;
  const day = Date.parse(`${istDate()}T00:00:00+05:30`);
  const sentToday = one("SELECT count(*) n FROM referrals WHERE stage NOT IN ('drafted','approved','skipped','failed') AND updated_at >= ? AND note IS NOT NULL", day).n;
  const sentWeek = one("SELECT count(*) n FROM referrals WHERE stage NOT IN ('drafted','approved','skipped','failed') AND updated_at >= ?", now() - 7 * 864e5).n;
  return sentToday < (c.per_day || 10) && sentWeek < (c.per_week || 70);
}
const nextGap = () => { const [a, b] = R().gap_min || [20, 40]; setKv('ref_next_at', now() + (a + Math.random() * (b - a)) * 60e3); };

export async function send() {
  if (!slotOpen()) return;
  const fu = one("SELECT * FROM referrals WHERE stage = 'followup_approved' ORDER BY updated_at LIMIT 1");
  if (fu) {
    nextGap();
    try {
      if (fu.email && (config().referrals?.email !== false)) {
        const { sendReferralEmail } = await import('./mail.mjs');
        await sendReferralEmail(fu.email, `Referral request: ${fu.job_title || 'Backend/AI Engineer'} at ${fu.company}`, fu.followup);
      } else {
        const res = await browserTask('linkedin_message', { url: fu.profile, text: fu.followup, attach: await resumeFor(fu) }, 10 * 60e3);
        if (res.status !== 'sent') throw new Error(res.reason || res.status);
      }
      set(fu.id, { stage: 'followup_sent' });
      activity(`🤝 Referral follow-up sent to ${fu.person} (${fu.company})`);
    } catch (e) { set(fu.id, { stage: 'failed', reason: e.message.slice(0, 300) }); logError('referral follow-up', e, { id: fu.id }); }
    return;
  }
  const r = one("SELECT * FROM referrals WHERE stage = 'approved' ORDER BY updated_at LIMIT 1");
  if (!r) return;
  nextGap();
  try {
    const res = await browserTask('linkedin_connect', { url: r.profile, note: r.note }, 10 * 60e3);
    if (res.status === 'limit') { setKv('ref_backoff_until', now() + 7 * 864e5); set(r.id, { stage: 'approved', reason: 'LinkedIn weekly invite limit: paused 7 days' });
      tell('🤝 LinkedIn says the weekly invitation limit is reached. Referral invites are paused for 7 days.'); return; }
    if (res.status === 'connected') { set(r.id, { stage: 'accepted', reason: 'already connected' }); return draftFollowup(r.id); }
    if (res.status !== 'invited') throw new Error(res.reason || res.status);
    set(r.id, { stage: 'invited', reason: res.withoutNote ? 'sent without a note (LinkedIn note limit)' : null });
    activity(`🤝 Invite sent to ${r.person} (${r.company})${res.withoutNote ? ' — without note (LinkedIn limit)' : ''}`);
  } catch (e) { set(r.id, { stage: 'failed', reason: e.message.slice(0, 300) }); logError('referral invite', e, { id: r.id }); }
}

async function resumeFor(r) {
  const { join } = await import('node:path');
  const { ROOT } = await import('./core.mjs');
  return join(ROOT, 'profile', config().naukri_resume || 'GPS_RESUME_SPRINGBOOT_DEVELOPER.pdf');
}

function draftFollowup(id) {
  const r = one('SELECT * FROM referrals WHERE id = ?', id);
  const text = followupText(r);
  set(id, { stage: 'followup_drafted', followup: text });
  tell(`🤝 ${r.person} (${r.company}) accepted your request! Referral message #${id}${r.email ? ` (by email to ${r.email}, resume attached)` : ' (LinkedIn message, resume attached)'}:\n\n${text}\n\n— Send, Skip, or type your own message.`,
    { refKind: 'referral', refId: id });
}

// 3) Once a day: who accepted? (and do they publish an email?)
export async function checkAccepted() {
  const due = all("SELECT * FROM referrals WHERE stage = 'invited' AND updated_at < ? ORDER BY updated_at LIMIT 8", now() - 20 * 3600e3);
  for (const r of due) {
    try {
      const st = await browserTask('linkedin_state', { url: r.profile }, 5 * 60e3);
      if (st.connected) { set(r.id, { stage: 'accepted', email: st.email || null }); draftFollowup(r.id); }
      else set(r.id, {});                                       // checked; look again tomorrow
    } catch (e) { logError('referral check', e, { id: r.id }); }
  }
}
