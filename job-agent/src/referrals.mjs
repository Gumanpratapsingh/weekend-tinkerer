// Referral outreach: for target companies (owner's list + companies with an 80%+ match), find people on LinkedIn
// (SRM alumni first), draft a short note naming the exact job, and ask the owner to approve EVERY message.
// Approved invites go out slowly (10/day, spaced, 9:00-21:00 IST). When someone accepts, a referral request with the
// resume follows: by email if they publish one, else a LinkedIn message, again only after approval.
import { config, log, logError, activity, master, persona, istHour, istDate, llm, yearsWorked } from './core.mjs';
import { one, all, run, getKv, setKv } from './db.mjs';
import { browserTask } from './browser.mjs';
import { tell } from './whatsapp.mjs';

const R = () => config().referrals || {};
const now = () => Date.now();
const set = (id, fields = {}) => {
  const keys = Object.keys(fields);
  if (!keys.length) {
    run('UPDATE referrals SET updated_at = ? WHERE id = ?', now(), id);
    return;
  }
  run(`UPDATE referrals SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...keys.map((k) => fields[k]), now(), id);
};

// Owner's list + companies where a job scored >= auto_min_score.
export function targetCompanies() {
  const list = new Set((R().companies || []).map((c) => c.trim()).filter(Boolean));
  for (const r of all('SELECT DISTINCT company FROM jobs WHERE score >= ? AND company IS NOT NULL', R().auto_min_score || 80)) list.add(r.company);
  return [...list];
}

// The years a job asks for ("3-5 years", "5+ yrs", "minimum 4 years"): the first stated number, or null when not stated.
export function yearsAsked(text) {
  const m = /(?:minimum|min\.?|at least)\s*(?:of\s*)?(\d{1,2})\s*\+?\s*(?:years|yrs)|(\d{1,2})\s*(?:\+|-|–|to)\s*\d{0,2}\s*\+?\s*(?:years|yrs)|(\d{1,2})\s*(?:years|yrs)\s*(?:of\s*)?(?:experience|exp)/i.exec(String(text || '').replace(/(\d)-to-(\d)/gi, '$1 to $2'));
  return m ? Number(m[1] || m[2] || m[3]) : null;
}
// A referral request names a role only when its stated experience fits: asking for a 5-15 years role with 2 years
// wastes the referrer's goodwill (it happened with Mphasis, whose LinkedIn post stated no years at all).
const fitsYears = (min) => min != null && min <= Math.floor(yearsWorked()) + 1;

// Best open job at a company from what the agent already found (needs a link to cite in the note), with a fitting
// experience requirement stated in it.
function jobAt(company) {
  const key = `%${company.toLowerCase().replace(/ (inc|ltd|llp|pvt|private|limited|group|global tech)\.?$/g, '')}%`;
  return all(`SELECT id, title, url, score, description FROM jobs WHERE lower(company) LIKE ? AND score >= 65
    AND status NOT IN ('skipped','filtered','rejected') ORDER BY score DESC, found_at DESC LIMIT 15`, key)
    .find((j) => fitsYears(yearsAsked(`${j.title}\n${j.description}`))) || null;
}

// The roles a hiring post itself lists (title, job ID, location, years). The referrer offers THOSE, so the note names
// one of them. Every field is checked against the post text: nothing the AI returns is used unless the post says it.
export async function rolesInPost(text) {
  let r;
  try {
    r = await llm([
      { role: 'system', content: 'List every open role this LinkedIn hiring post names. Copy values exactly from the post; null when the post does not state one. '
        + 'Return JSON {"roles":[{"title":"","job_id":null,"location":null,"min_years":null}]} (min_years = the lowest years of experience it asks for).' },
      { role: 'user', content: text.slice(0, 4000) },
    ], { json: true, maxTokens: 800, temperature: 0, small: true, why: 'reading the roles in a referral post' });
  } catch { return []; }
  const t = text.toLowerCase();
  return (r?.roles || []).filter((x) => x?.title && t.includes(String(x.title).toLowerCase().slice(0, 25)))
    .map((x) => ({ title: String(x.title).trim(), job_id: x.job_id && t.includes(String(x.job_id).toLowerCase()) ? String(x.job_id) : null,
      location: x.location || null, min_years: Number.isFinite(Number(x.min_years)) && x.min_years !== null ? Number(x.min_years) : null }));
}

function note(person, job, company, alumni, colleagueOrg = null) {
  const first = String(person).split(/\s+/)[0];
  const m = master();
  const P = persona();
  const org = colleagueOrg && m.experience.find((e) => e.org.toLowerCase().includes(colleagueOrg.toLowerCase().split(/\s+/)[0]))?.org.split(/\s+/)[0];
  const intro = org ? `we've both worked at ${org}` : alumni ? `fellow ${P.school_short || 'school'} alum here${P.alum_tag ? ` (${P.alum_tag})` : ''}` : (P.intro || `I'm a ${m.experience[0]?.title || 'professional'}`);
  const role = job ? `the ${job.title} role${job.id ? ` (job ${String(job.id).split(':').pop()})` : ''}` : (P.fallback_role || 'a role there');
  // LinkedIn invite notes are capped at 300 characters.
  return `Hi ${first}, ${intro}. ${String(P.pitch || `I work as ${m.experience[0]?.title} at ${m.experience[0]?.org}`).replace(/\.$/, '')}. I'm applying for ${role} at ${company}. Would you be open to referring me? Happy to share my resume. Thanks! – ${m.name.split(' ')[0]}`.slice(0, 300);
}

function followupText(r) {
  const first = String(r.person).split(/\s+/)[0];
  const m = master();
  const P = persona();
  return `Thanks for connecting, ${first}! I'd be grateful for a referral for ${r.job_title ? `the ${r.job_title} role` : (P.fallback_role || 'a role')} at ${r.company}${r.job_url ? `: ${r.job_url}` : ''}.\n\n`
    + `Quick summary: ${m.experience[0].title} at ${m.experience[0].org}${P.followup_summary ? `, ${P.followup_summary}` : ''}. `
    + `Resume attached. Happy to answer anything. Thank you!\n– ${m.name}, ${m.contact.phone}`;
}

// 1) Find people at the next target company and queue drafts for approval (a few companies per run).
//    { only, jobId }: the owner asked for referrals for one specific job (cites that job, skips the queue checks).
export async function prospect({ only, jobId } = {}) {
  const done = new Set(all('SELECT DISTINCT company FROM referrals').map((r) => r.company.toLowerCase()));
  const waiting = one("SELECT count(*) n FROM referrals WHERE stage = 'drafted'").n;
  if (!only && waiting >= 15) return;                           // don't flood the owner with drafts
  const companies = only ? [only] : targetCompanies().filter((c) => !done.has(c.toLowerCase())).slice(0, 2);
  for (const company of companies) {
    const job = jobId ? one('SELECT id, title, url, score FROM jobs WHERE id = ?', jobId) : jobAt(company);
    let people;
    try { people = (await browserTask('linkedin_people', { company, school: R().school || persona().school_short || '' }, 10 * 60e3)).people || []; }
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
      tell(`🤝 Referral request #${id}: ${p.name}${p.alumni ? ` (${persona().school_short || 'school'} alum)` : ''}\n${p.headline || ''}\n${p.url}\n\nNote:\n${text}\n\n— Send, Skip, or type your own note to send instead.`,
        { refKind: 'referral', refId: id });
    }
  }
}

// The "🤝 Find referral" button on a job card: people who could refer the person for THIS job, best first: former
// colleagues who work there now and school alumni (LinkedIn's own "People you can reach out to" panel on the job page),
// then senior people at that company in the job's region (tech lead, engineering manager…). Each becomes a draft note
// for approval in the same chat; nothing is sent until "Send", and sends keep the usual daily/weekly limits.
const SENIOR = /\b(lead|manager|principal|staff|architect|head|director|senior|sr\.?|vp)\b/i;
const NCR_RE = /\b(gurugram|gurgaon|noida|greater noida|delhi|new delhi|ncr|ghaziabad|faridabad)\b/i;
export async function refForJob(jobId, { chat = null } = {}) {
  const job = one('SELECT * FROM jobs WHERE id = ?', jobId);
  if (!job) return;
  const P = persona(), school = R().school || P.school_short || '';
  const say = (t, more = {}) => tell(t, { chat, ...more });
  say(`🔎 Looking for people who could refer you at ${job.company} (former colleagues, ${school || 'school'} alumni, senior people${NCR_RE.test(job.location || '') ? ' in Delhi NCR' : ''})…`);
  const people = new Map();
  if (/linkedin\.com\/jobs\/view\//.test(job.url || '')) {
    const r = await browserTask('linkedin_job_network', { url: job.url }, 5 * 60e3).catch((e) => { log(`job network ${job.id}: ${e.message}`); return { people: [] }; });
    for (const p of r.people || []) if (['colleague', 'alumni'].includes(p.tag)) people.set(p.url, p);
  }
  // Senior people who'd know the team: product leads for a product/analyst role, engineering leads otherwise.
  const product = job.track === 'product' || /product|business analyst|project manager|analyst/i.test(job.title || '');
  const seniors = R().senior_titles || P.referral_seniors
    || (product ? ['senior product manager', 'product lead', 'engineering manager'] : ['tech lead', 'engineering manager', 'principal engineer', 'senior software engineer']);
  const r2 = await browserTask('linkedin_people', { company: job.company, school, queries: [[`${job.company} ${school}`, true], ...seniors.map((t) => [`${job.company} ${t}`, 'senior'])] }, 12 * 60e3)
    .catch((e) => { log(`referral people ${job.company}: ${e.message}`); return { people: [] }; });
  const region = NCR_RE.test(job.location || '') ? NCR_RE : null;
  for (const p of r2.people || []) {
    if (people.has(p.url)) continue;
    if (p.tag === 'senior' && (!SENIOR.test(p.headline || '') || (region && !region.test(p.location || '')))) continue;   // senior AND in the job's region
    if (p.tag === 'other' && !p.alumni) continue;
    people.set(p.url, { ...p, tag: p.alumni ? 'alumni' : p.tag });
  }
  const rank = { colleague: 0, alumni: 1, senior: 2 };
  const picks = [...people.values()].filter((p) => !one('SELECT 1 FROM referrals WHERE profile = ?', p.url))
    .sort((a, b) => (rank[a.tag] ?? 3) - (rank[b.tag] ?? 3)).slice(0, R().people_per_job || 5);
  activity(`🤝 Referrals for ${job.title} @ ${job.company}: ${people.size} found, ${picks.length} new drafted`);
  if (!picks.length) return say(`🤝 Nobody new at ${job.company} who could refer you${people.size ? ' (everyone found was already contacted)' : ''}.`);
  for (const p of picks) {
    const text = note(p.name, job, job.company, p.tag === 'alumni', p.tag === 'colleague' ? (p.org || master().experience[0]?.org) : null);
    run(`INSERT OR IGNORE INTO referrals(company, job_id, job_title, job_url, person, headline, profile, alumni, stage, note, source, created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, job.company, job.id, job.title, job.url, p.name, p.headline || '', p.url, p.tag === 'alumni' ? 1 : 0, 'drafted', text, 'job', now());
    const id = one('SELECT id FROM referrals WHERE profile = ?', p.url).id;
    if (p.degree === '1st') { set(id, { stage: 'accepted', reason: 'already a connection' }); draftFollowup(id); continue; }
    const who = p.tag === 'colleague' ? `former ${p.org || 'colleague'} colleague` : p.tag === 'alumni' ? `${school} alum` : 'senior at the company';
    tell(`🤝 Referral #${id} for ${job.title} @ ${job.company}\n${p.name} (${who}${p.degree ? `, ${p.degree}` : ''})\n${p.headline || ''}${p.location ? `\n${p.location}` : ''}\n\nInvite note:\n${text}\n\n— Send, Skip, or type your own note.`,
      { refKind: 'referral', refId: id, chat, links: [{ label: 'Profile ↗', url: p.url }] });
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
  const { resumeFile } = await import('./core.mjs');
  return resumeFile();
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

// ---------- Referral offers in LinkedIn posts: verified authors at MNCs, spam filtered ----------
const OFFER = /\b(i|we)('?ll| can| will| am happy to| would be happy to)? ?(refer|be referring)\b|\breferrals? (are )?(open|available)\b|\bdm (me )?for (a )?referral|\bdrop (your )?(resume|cv)|\bsend (me )?(your )?(resume|cv)\b|\b(is|are|we're|we are) hiring\b|\bhiring for\b|\bopenings? (in|at) (my|our)\b|🚀 ?referral/i;
const SEEKER = /\b(i am|i'm|im) (actively |currently )?(looking|seeking|searching)\b|open to work|immediate joiner|seeking (new )?opportunit|looking for (my first|a new|new) (job|role|opportunit)|day \d+ of|my .{0,20}journey|please (help|refer) me|need (a )?referral/i;
const SPAM = /₹|\brs\.? ?\d|\binr\b|\bfees?\b|\bpay(ment)?\b|registration|guarantee|100 ?%|placement|\bcourse\b|training|\bbatch\b|telegram|t\.me\/|whatsapp|wa\.me|comment .{0,12}interested|link in (bio|comments)|follow me|job updates|ghost ?writer|content creator/i;

function employerOf(headline, list) {
  const h = ` ${headline} `.toLowerCase();
  return list.find((co) => new RegExp(`(@|\\bat |\\b)${co.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(h)) || null;
}

export function judgePost(p, list) {
  if (!p.verified) return 'author not verified';
  if (!OFFER.test(p.text)) return 'not a referral offer';
  if (SEEKER.test(p.text.slice(0, 600)) && !/\b(i can|i'll|will) refer\b/i.test(p.text)) return 'author is looking for work';
  if (SPAM.test(`${p.headline} ${p.text}`)) return 'spam signs';
  if (!employerOf(p.headline, list)) return 'author not at an MNC';
  return null;
}

// A post role is worth naming only when it is the person's kind of work (a Mainframe or QA opening is not, for a Java developer).
export function fitsSkills(title) {
  const m = master(), P = persona();
  const mine = `${P.fit_roles || ''} ${m.experience.map((e) => e.title).join(' ')} ${Object.values(m.skills || {}).flat().join(' ')}`.toLowerCase();
  const words = String(title).toLowerCase().match(/[a-z][a-z+#.]{1,}/g) || [];
  const STOP = /^(and|the|for|with|lead|senior|sr|jr|junior|associate|process|role|team|level|i|ii|iii|module|specialist|consultant)$/;
  return words.some((w) => !STOP.test(w) && mine.includes(w));
}

export async function scanPosts() {
  const c = R();
  const list = [...new Set([...(c.companies || []), ...(c.mnc || [])])];
  let posts = [];
  try { posts = (await browserTask('linkedin_posts', { queries: c.post_queries || [] }, 20 * 60e3)).posts || []; }
  catch (e) { logError('referral posts', e); return; }
  let kept = 0;
  const why = {};
  for (const p of posts) {
    const reason = judgePost(p, list);
    if (reason) { why[reason] = (why[reason] || 0) + 1; continue; }
    if (one('SELECT 1 FROM referrals WHERE profile = ?', p.profile)) continue;
    const company = employerOf(p.headline, list);
    const roles = await rolesInPost(p.text);
    const pick = roles.find((r) => fitsYears(r.min_years) && fitsSkills(r.title));
    if (!pick && roles.length) {                   // the post lists its roles and none fits: don't ask about some other job there
      why['no role in the post fits your experience'] = (why['no role in the post fits your experience'] || 0) + 1;
      continue;
    }
    const job = pick ? null : jobAt(company);
    const first = p.author.split(/\s+/)[0];
    const P = persona();
    const role = pick ? `the ${pick.title} role${pick.job_id ? ` (Job ID ${pick.job_id})` : ''}${pick.location ? ` in ${pick.location}` : ''}`
      : job ? `the ${job.title} role` : (P.post_fallback_role || P.fallback_role || 'a role there');
    const text = `Hi ${first}, saw your post about referrals at ${company}. ${P.post_pitch || P.intro || ''}. I'd love to be considered for ${role}. Would you be open to referring me? Happy to share my resume. Thanks! – ${master().name.split(' ')[0]}`.replace(/\.\. /, '. ').slice(0, 300);
    run(`INSERT OR IGNORE INTO referrals(company, job_id, job_title, job_url, person, headline, profile, alumni, stage, note, source, post, created_at)
      VALUES(?,?,?,?,?,?,?,0,'drafted',?,'post',?,?)`, company, job?.id || null, pick ? `${pick.title}${pick.job_id ? ` (Job ID ${pick.job_id})` : ''}` : job?.title || null,
      job?.url || null, p.author, p.headline, p.profile, text, p.text.slice(0, 4000), now());
    const id = one('SELECT id FROM referrals WHERE profile = ?', p.profile).id;
    kept++;
    tell(`🤝 Referral offer in a LinkedIn post (verified, ${company}) #${id}: ${p.author}\n${p.headline}\n${p.profile}\n\nTheir post: "${p.text.replace(/\s+/g, ' ').slice(0, 260)}…"\n\nYour note:\n${text}\n\n— Send, Skip, or type your own note.`,
      { refKind: 'referral', refId: id });
  }
  activity(`🤝 Referral posts: ${posts.length} read, ${kept} kept · skipped: ${Object.entries(why).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}`);
}
