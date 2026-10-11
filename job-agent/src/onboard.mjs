// First-time setup for a person other than the owner, entirely in their own Cupboard chat:
// resume (PDF) -> their own free Gemini key reads it (facts only) -> they check EVERY detail and correct it -> roles,
// cities, minimum salary -> Gmail (app password, tested, then hidden in the chat) -> LinkedIn and Naukri sign-in on the
// phone's browser through a live sign-in page (they type into the real site; we keep only the session) -> setup questions.
// Any login step can be skipped and done later by sending "login linkedin" / "login naukri" / "login gmail".
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { ROOT, PROFILE, OWNER, HOME, PERSON, AGENT_URL, log, logError, secret, readJson, privateProfile, llm, gate, hasSession } from './core.mjs';
import { browserTask } from './browser.mjs';
import { getKv, setKv } from './db.mjs';
import { tell } from './whatsapp.mjs';

export const needsSetup = () => !OWNER && getKv('onboard') !== 'done';
const say = (text, step) => tell(text, step ? { refKind: 'onboard', refId: step } : {});

export function startOnboarding() {
  if (!needsSetup()) return;
  const step = getKv('onboard') || 'resume';
  const last = Number(getKv('onboard_nudged', 0));
  if (Date.now() - last < 20 * 3600e3) return;           // at most one reminder a day
  setKv('onboard_nudged', Date.now());
  if (step === 'resume') {
    setKv('onboard', 'resume');
    say(`👋 Hi! I'm your job agent. I find jobs on company career pages, LinkedIn and Naukri, check how well each fits you, `
      + `fill the applications, and ask you here whenever I meet a question I can't answer.\n\n`
      + `To start, attach your resume here as a PDF (tap 📎). I'll read it and set everything up from it. I only ever use facts from your resume.`);
  } else ask(step);
}

// ---------- 1) resume ----------
const PROMPT = `Read this resume and return ONE JSON object. Use ONLY facts written in the resume; never invent skills, numbers,
employers, dates or links. Missing facts: empty string / empty list. Never guess gender or pronouns.
{
 "name": "", "contact": {"phone": "+91 ...", "email": "", "linkedin": "linkedin.com/in/... (no https)", "github": "github.com/... (no https)", "location": "City, State"},
 "education": [{"school": "", "place": "", "degree": "", "dates": ""}],
 "experience": [{"id": "e1", "title": "", "org": "", "place": "", "dates": "Mon YYYY – Present", "bullets": [{"id": "e1b1", "text": "<the bullet, as written>", "supports": ["<terms this bullet proves>"]}]}],
 "projects": [{"id": "p1", "name": "", "stack": "", "link": "", "track": "backend", "bullets": [{"id": "p1b1", "text": "", "supports": []}]}],
 "skills": {"<category as on the resume>": ["..."]},
 "career_start": "YYYY-MM of the first full-time job (not internships)",
 "graduation": "Mon YYYY", "degree_answer": "e.g. Bachelor's degree (B.Tech, Computer Science)", "field": "e.g. Computer Science",
 "school_short": "short name people use for the college, e.g. SRM, VIT, NIT Trichy", "alum_tag": "e.g. B.Tech CS '24",
 "headline": "<= 8 words, e.g. Java backend engineer",
 "pitch": "first person, <= 100 chars, e.g. I build Java/Spring Boot services at Acme (2+ yrs)",
 "summary": "<= 35 words resume summary in third person without a name, use {years} for years of experience",
 "facts": ["3-5 short factual lines an application form might need: main stack, domains, kinds of systems built"],
 "lacks": "comma list of common tools in this field the resume does NOT show",
 "roles": ["6-9 job-search queries for roles this person fits, e.g. 'java developer', 'backend developer'"],
 "title_include": ["10-20 lowercase keywords a fitting job title contains"],
 "title_exclude_extra": ["lowercase title keywords for clearly unrelated roles"]
}`;

async function readResume(pdf) {
  const key = secret('gemini_key');
  if (!key) throw new Error('no Gemini key for this person');
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, signal: AbortSignal.timeout(300000),   // a resume takes Gemini ~2 minutes
    body: JSON.stringify({ contents: [{ parts: [{ inline_data: { mime_type: 'application/pdf', data: readFileSync(pdf).toString('base64') } }, { text: PROMPT }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0 } }) });
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const text = (await r.json()).candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
  return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
}

export async function receiveFile({ file, name }) {
  if (OWNER) return tell('📄 Got the file. (Resume changes for the owner are done on the Mac.)');
  if (!/\.pdf$/i.test(file) || !existsSync(file)) return say('Please attach your resume as a PDF.');
  const fname = basename(String(name || 'resume.pdf')).replace(/[^\w .()-]/g, '').replace(/(\.pdf)?$/i, '.pdf');
  copyFileSync(file, join(PROFILE, fname));
  say(`📄 Got ${fname}. Reading it now (about a minute)…`);
  let x;
  try { x = await readResume(join(PROFILE, fname)); }
  catch (e) { logError('onboard resume', e); return say(`I couldn't read that resume (${e.message.slice(0, 120)}). Try attaching it again in a few minutes.`); }
  if (!x?.name || !x.experience) return say("That PDF didn't look like a resume to me. Please attach your resume.");

  const bare = (s) => String(s || '').trim().replace(/[.\s]+$/, '');   // the notes add their own punctuation
  x.pitch = bare(x.pitch); x.headline = bare(x.headline);
  const persona = { _note: 'Per-person wording the agent uses in scoring, form answers, referral notes and resume summaries. Facts only.',
    career_start: x.career_start || '', graduation: x.graduation || '', degree_answer: x.degree_answer || '', field: x.field || '',
    school_short: x.school_short || '', alum_tag: x.alum_tag || '', pronoun: 'they', location_line: '',
    fit_roles: (x.roles || []).slice(0, 4).join(', '), lacks: x.lacks || '', seed_skills: Object.values(x.skills || {}).flat().slice(0, 2),
    intro: `I'm a ${x.headline || x.experience?.[0]?.title || 'professional'}`, pitch: x.pitch || '', post_pitch: x.pitch ? `${x.pitch}` : '',
    followup_summary: '', fallback_role: `a ${x.headline || 'suitable'} role`, facts: [
      'Citizenship: Indian, lives in India. Not authorized to work in the US or EU; holds no foreign visa.', ...(x.facts || [])],
    summary_backend: x.summary || '', summary_numbers: '' };
  const master = { _note: 'Built from the resume the person attached in Cupboard. Every tailored resume uses ONLY this file.',
    name: x.name, contact: x.contact || {}, education: x.education || [], experience: x.experience || [], projects: x.projects || [],
    skills: x.skills || {}, persona };
  writeFileSync(join(PROFILE, 'master.json'), JSON.stringify(master, null, 2));

  // config.json: the owner's settings as a template, with this person's roles, a share of the daily caps, no Naukri headline rotation.
  const base = readJson(join(ROOT, 'profile', 'config.json'), {});
  const years = x.career_start ? Math.max(0, Math.floor((Date.now() - Date.parse(`${x.career_start}-01`)) / (365.25 * 864e5))) : 0;
  const cfg = { ...base, ...readJson(join(PROFILE, 'config.json'), {}),
    tracks: { backend: { queries: (x.roles || []).slice(0, 9) } }, experience_years: years,
    title_include: x.title_include?.length ? x.title_include : base.title_include,
    title_exclude: [...new Set([...['senior', 'sr.', 'sr ', 'lead', 'principal', 'staff', 'architect', 'manager', 'director', 'head of', 'vp ', 'intern', 'internship'], ...(x.title_exclude_extra || [])])],
    daily_caps: { naukri: 25, linkedin: 10, ats: 20, total: 55, per_company: 3 },
    naukri_headlines: [], naukri_resume: fname,
    referrals: { ...(base.referrals || {}), companies: [], school: x.school_short || '' } };
  writeFileSync(join(PROFILE, 'config.json'), JSON.stringify(cfg, null, 2));
  const priv = privateProfile();
  writeFileSync(join(PROFILE, 'private.json'), JSON.stringify({ ...priv, mailbox: priv.mailbox || x.contact?.email || '', known_answers: priv.known_answers || {} }, null, 2));
  log(`onboard: resume read for ${x.name}`);

  if (['resume', 'review', null, ''].includes(getKv('onboard'))) setKv('onboard', 'review');
  review('✅ Read it. Please check every detail below. Every application and message I send is built only from this.');
}

// ---------- 1b) the person checks every detail (and fixes anything) before it is used ----------
function review(head) {
  const m = readJson(join(PROFILE, 'master.json'), {}), P = m.persona || {}, c = m.contact || {};
  const exp = (m.experience || []).map((e) => `▸ ${e.title} — ${e.org}${e.place ? `, ${e.place}` : ''} (${e.dates})\n${(e.bullets || []).map((b) => `   • ${b.text}`).join('\n')}`).join('\n');
  const proj = (m.projects || []).map((p) => `▸ ${p.name}${p.stack ? ` [${p.stack}]` : ''}${p.link ? ` ${p.link}` : ''}\n${(p.bullets || []).map((b) => `   • ${b.text}`).join('\n')}`).join('\n');
  const parts = [
    `${head}\n\n👤 ${m.name}\n📞 ${c.phone || '—'} · ✉️ ${c.email || '—'}\n📍 ${c.location || '—'}\n🔗 ${c.linkedin || '—'} · ${c.github || '—'}\n\n🎓 ${(m.education || []).map((e) => `${e.degree}, ${e.school}${e.place ? `, ${e.place}` : ''} (${e.dates})`).join('\n🎓 ')}`
      + `\nCollege short name: ${P.school_short || '—'} · Graduated: ${P.graduation || '—'} · Full-time since: ${P.career_start || '—'}`,
    `💼 Experience\n${exp || '—'}`,
    `🛠 Projects\n${proj || '—'}\n\n🧰 Skills\n${Object.entries(m.skills || {}).map(([k, v]) => `${k}: ${v.join(', ')}`).join('\n')}`,
    `✍️ How I'll describe you\nIn referral notes: "${P.intro}. ${P.pitch}."\nResume summary: "${String(P.summary_backend || '').replace('{years}', 'N+')}"\nFor forms: ${(P.facts || []).slice(1).join(' · ')}`,
  ];
  for (const t of parts.slice(0, -1)) say(t);
  say(`${parts.at(-1)}\n\nAll correct? Reply "ok". Otherwise reply with what to change, in your own words, e.g. "phone is +91 98xxxxxx, Acme dates are Jun 2024 – Present, add skill Python, remove the second project".`, 'review');
}

async function applyFix(text) {
  const path = join(PROFILE, 'master.json');
  const m = readJson(path, {});
  say('✏️ Updating…');
  let out;
  try {
    out = await llm([
      { role: 'system', content: 'You edit a resume JSON. Apply ONLY the changes the person asks for, exactly as they state them. '
        + 'Keep every other field, id and value unchanged. Never add anything they did not state. Return the complete JSON object.' },
      { role: 'user', content: `JSON:\n${JSON.stringify(m)}\n\nCHANGES:\n${text}` },
    ], { json: true, maxTokens: 6000, temperature: 0, why: 'applying your corrections to your profile' });
  } catch (e) { return say(`I couldn't apply that right now (${e.message.slice(0, 80)}). Send it again in a few minutes.`, 'review'); }
  if (!out?.name || !Array.isArray(out.experience) || !out.contact) return say("I couldn't apply that cleanly. Could you say it another way?", 'review');
  out.persona = { ...m.persona, ...(out.persona || {}) };
  writeFileSync(path, JSON.stringify(out, null, 2));
  review('Updated. Here is everything again; please check it once more.');
}

// ---------- 2) preferences ----------
function ask(step) {
  const c = readJson(join(PROFILE, 'config.json'), {});
  if (step === 'roles') return say(`🔎 I'll search for these roles:\n${(c.tracks?.backend?.queries || []).map((q) => `• ${q}`).join('\n')}\n\nReply "ok", or send your own list (comma-separated).`, 'roles');
  if (step === 'cities') return say('📍 Which cities? Reply "anywhere" (any city in India + remote), or list them, e.g. "Bengaluru, Hyderabad, remote".', 'cities');
  if (step === 'salary') return say("💰 What's the lowest salary you'd accept, in LPA? I skip jobs that state less. (e.g. 8, or 0 for no limit)", 'salary');
  if (step === 'review') return review('Please check these details once more.');
  if (step === 'mailbox') return say(`✉️ Which Gmail gets your job emails (recruiter replies, interview invites)? Reply "ok" for ${privateProfile().mailbox || 'the one on your resume'}, or send the address. ("skip" to do this later.)`, 'mailbox');
  if (step === 'gmail') return say(`🔑 To read job replies I need a Gmail app password: a 16-letter code that only allows mail access. You can delete it anytime and your real password stays private.\n\n`
    + `1. Open myaccount.google.com/apppasswords (signed in as ${privateProfile().mailbox}). If it says the setting isn't available, first turn on 2-Step Verification under Security.\n2. Name it "Job agent", tap Create.\n3. Reply here with the 16-letter code.\n\nI test it, save it on the phone, and hide your message here. ("skip" to do this later.)`, 'gmail');
  if (step === 'linkedin' || step === 'naukri') return signinCard(step);
}

const SITES = { linkedin: 'LinkedIn', naukri: 'Naukri' };
async function signinCard(site) {
  let link = null;
  try {
    const r = await fetch('http://127.0.0.1:8086/signin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(5000),
      body: JSON.stringify({ to: privateProfile().cupboard_user, agent: AGENT_URL, site }) });
    link = (await r.json()).path;
  } catch (e) { log(`signin link: ${e.message}`); }
  if (!link) return say(`I couldn't open the ${SITES[site]} sign-in page just now. Send "login ${site}" to try again.`);
  tell(`🔐 Sign in to ${SITES[site]}\nTap "Open sign-in". You'll see the phone's browser on ${SITES[site]}'s real login page: tap the boxes and type in the box below the screen. `
    + `Your password goes straight to ${SITES[site]}; I only keep the signed-in session so I can apply for you. If ${SITES[site]} sends a code (OTP), type it there too.\n\n("skip" to do this later.)`,
    { refKind: 'onboard', refId: site, link: { label: `Open ${SITES[site]} sign-in`, path: link } });
}

// The sign-in page is open: run the browser task (waits its turn on the shared browser), report back here.
export async function startSignin(site) {
  if (!SITES[site]) throw new Error('unknown site');
  if (getKv(`signin_running_${site}`) && Date.now() - Number(getKv(`signin_running_${site}`)) < 20 * 60e3) return { ok: true, already: true };
  setKv(`signin_running_${site}`, Date.now());
  browserTask('signin', { site }, 20 * 60e3).then((r) => {   // runs right away in its own browser (not queued)
    setKv(`signin_running_${site}`, '');
    if (r.ok) { setKv(`session_${site}`, 'ok'); setKv(`signin_done_${site}`, Date.now()); say(`✅ Signed in to ${SITES[site]}. I'll take it from here.`); if (getKv('onboard') === site) next(site); }
    else say(`${SITES[site]} sign-in didn't finish (${r.reason || 'timed out'}). Send "login ${site}" to try again.`);
  }).catch((e) => { setKv(`signin_running_${site}`, ''); logError('signin', e, { site }); say(`${SITES[site]} sign-in stopped (${e.message.slice(0, 80)}). Send "login ${site}" to try again.`); });
  return { ok: true };
}

const ORDER = ['resume', 'review', 'roles', 'cities', 'salary', 'mailbox', 'gmail', 'linkedin', 'naukri', 'done'];
function next(step) {
  const n = ORDER[ORDER.indexOf(step) + 1] || 'done';
  setKv('onboard', n);
  if (n !== 'done') return ask(n);
  gate.open = true;                                       // the job search starts now; setup questions follow
  say("🎉 All set! I'm starting the job search now. A few standard questions come next, the ones almost every application asks. Answer each with Reply; I remember them for every future application.\n\n"
    + 'Anytime: ask me "what\'s waiting for me?" or "applied today", or send "login linkedin" / "login naukri" / "login gmail".');
}

async function saveGmail(text, msgId) {
  const code = String(text).replace(/\s+/g, '');
  if (!/^[a-z]{16}$/i.test(code)) return say('That should be 16 letters (spaces are fine). Try again, or "skip".', 'gmail');
  const { ImapFlow } = await import('imapflow');
  const imap = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, logger: false, auth: { user: privateProfile().mailbox, pass: code } });
  try { await imap.connect(); await imap.logout(); }
  catch { hide(msgId); return say(`Gmail didn't accept that code for ${privateProfile().mailbox}. Check the address and create a new code, or "skip".`, 'gmail'); }
  const dir = join(HOME, `.jobagent-${PERSON}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'gmail_app_password'), code, { mode: 0o600 });
  hide(msgId);
  say(`✅ Gmail connected. I check ${privateProfile().mailbox} every 2 hours for replies and never send anything without your OK.`);
  next('gmail');
}
// Replace a message that carried a secret with a placeholder (Cupboard keeps chat history).
function hide(msgId) {
  if (!msgId) return;
  fetch('http://127.0.0.1:8086/redact', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(5000),
    body: JSON.stringify({ id: Number(msgId), text: '🔒 (hidden: saved securely on the phone)' }) }).catch(() => {});
}

/** "login linkedin" / "login naukri" / "login gmail" at any time. Returns true if handled. */
export function loginCommand(text) {
  const m = /^(?:login|sign ?in|connect)\s+(linkedin|naukri|gmail)$/i.exec(String(text).trim());
  if (!m) return false;
  const site = m[1].toLowerCase();
  if (site === 'gmail') ask(privateProfile().mailbox ? 'gmail' : 'mailbox'); else signinCard(site);
  return true;
}
/** Is the person in a setup step that takes free text (so a plain message is an answer, never sent to the AI)? */
export const pendingStep = () => (needsSetup() ? getKv('onboard') || 'resume' : null);

export function onboardReply(step, text, msgId = null) {
  const t = String(text).trim(), path = join(PROFILE, 'config.json');
  const c = readJson(path, {});
  const skip = /^(skip|later|not now)$/i.test(t);
  if (step === 'resume') return say('Please attach your resume as a PDF with 📎.', 'resume');
  if (step === 'review') {
    if (/^(ok|okay|yes|correct|all good|👍)$/i.test(t)) return next('review');
    return applyFix(t).catch((e) => logError('onboard fix', e));
  }
  if (step === 'mailbox') {
    if (skip) { setKv('onboard', 'gmail'); return next('gmail'); }
    if (!/^(ok|okay|yes|👍)$/i.test(t)) {
      if (!/^[^\s@]+@gmail\.com$/i.test(t)) return say('Send a Gmail address (…@gmail.com), "ok", or "skip".', 'mailbox');
      const priv = privateProfile(); priv.mailbox = t.toLowerCase();
      writeFileSync(join(PROFILE, 'private.json'), JSON.stringify(priv, null, 2));
    }
    return next('mailbox');
  }
  if (step === 'gmail') { if (skip) { hide(msgId); return next('gmail'); } return saveGmail(t, msgId).catch((e) => logError('onboard gmail', e)); }
  if (step === 'linkedin' || step === 'naukri') {
    if (skip) return getKv('onboard') === step ? next(step) : say('OK, later.');
    return say(`Tap "Open ${SITES[step]} sign-in" above to sign in (or "skip").`);
  }
  if (step === 'roles') {
    if (!/^(ok|okay|yes|👍)$/i.test(t)) {
      const roles = t.split(/[,\n]+/).map((x) => x.trim().toLowerCase()).filter(Boolean).slice(0, 12);
      if (!roles.length) return say('Send the roles separated by commas, or "ok".', 'roles');
      c.tracks = { backend: { queries: roles } };
    }
    writeFileSync(path, JSON.stringify(c, null, 2));
    return next('roles');
  }
  if (step === 'cities') {
    const base = readJson(join(ROOT, 'profile', 'config.json'), {}).locations;
    if (/^(any|anywhere|all|any city|anywhere in india)/i.test(t)) c.locations = base;
    else {
      const list = t.split(/[,\n]+/).map((x) => x.trim().toLowerCase()).filter(Boolean).slice(0, 15);
      const remote = list.some((x) => /remote|wfh|work from home/.test(x));
      const cities = list.filter((x) => !/remote|wfh|work from home/.test(x));
      if (!cities.length && !remote) return say('Send city names separated by commas, or "anywhere".', 'cities');
      const alias = { bangalore: 'bengaluru', bengaluru: 'bangalore', gurgaon: 'gurugram', gurugram: 'gurgaon', bombay: 'mumbai' };
      c.locations = { ...base, preferred: [...new Set(cities.flatMap((x) => [x, alias[x]].filter(Boolean)))], other_cities: [], only_listed: true,
        remote_ok: remote ? base.remote_ok : [],
        naukri: [...cities.map((x) => ({ location: x })), ...(remote ? [{ location: 'remote' }] : [])],
        linkedin: [...cities.map((x) => ({ location: `${x.replace(/\b\w/g, (m) => m.toUpperCase())}, India` })), ...(remote ? [{ location: 'India', remote: true }] : [])] };
    }
    writeFileSync(path, JSON.stringify(c, null, 2));
    return next('cities');
  }
  if (step === 'salary') {
    const n = Number((/\d+(\.\d+)?/.exec(t) || [])[0]);
    if (!Number.isFinite(n)) return say('Just the number in LPA, e.g. 8 (or 0 for no limit).', 'salary');
    c.min_salary_lpa = n;
    writeFileSync(path, JSON.stringify(c, null, 2));
    return next('salary');
  }
}
