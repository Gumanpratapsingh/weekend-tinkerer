// First-time setup for a person other than the owner, entirely in their own Cupboard chat:
// 1) they attach their resume (PDF) -> their own free Gemini key reads it into master.json (facts only, nothing invented),
// 2) they confirm roles, cities and minimum salary, 3) the usual setup questions follow (notice period, CTC...).
// Logins (Naukri, LinkedIn) and the Gmail app password are added later by the owner, not here.
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, PROFILE, OWNER, log, logError, secret, readJson, privateProfile } from './core.mjs';
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

  const exp = x.experience?.[0];
  say(`✅ Read it. ${x.name}${exp ? `, ${exp.title} at ${exp.org}` : ''}${years ? `, about ${years} year(s) full-time` : ''}. `
    + `Skills I'll use: ${Object.values(x.skills || {}).flat().slice(0, 12).join(', ')}.`);
  if (getKv('onboard') === 'resume' || !getKv('onboard')) { setKv('onboard', 'roles'); ask('roles'); }
}

// ---------- 2) preferences ----------
function ask(step) {
  const c = readJson(join(PROFILE, 'config.json'), {});
  if (step === 'roles') return say(`🔎 I'll search for these roles:\n${(c.tracks?.backend?.queries || []).map((q) => `• ${q}`).join('\n')}\n\nReply "ok", or send your own list (comma-separated).`, 'roles');
  if (step === 'cities') return say('📍 Which cities? Reply "anywhere" (any city in India + remote), or list them, e.g. "Bengaluru, Hyderabad, remote".', 'cities');
  if (step === 'salary') return say("💰 What's the lowest salary you'd accept, in LPA? I skip jobs that state less. (e.g. 8, or 0 for no limit)", 'salary');
}

export function onboardReply(step, text) {
  const t = String(text).trim(), path = join(PROFILE, 'config.json');
  const c = readJson(path, {});
  if (step === 'roles') {
    if (!/^(ok|okay|yes|👍)$/i.test(t)) {
      const roles = t.split(/[,\n]+/).map((x) => x.trim().toLowerCase()).filter(Boolean).slice(0, 12);
      if (!roles.length) return say('Send the roles separated by commas, or "ok".', 'roles');
      c.tracks = { backend: { queries: roles } };
    }
    writeFileSync(path, JSON.stringify(c, null, 2));
    setKv('onboard', 'cities'); return ask('cities');
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
    setKv('onboard', 'salary'); return ask('salary');
  }
  if (step === 'salary') {
    const n = Number((/\d+(\.\d+)?/.exec(t) || [])[0]);
    if (!Number.isFinite(n)) return say('Just the number in LPA, e.g. 8 (or 0 for no limit).', 'salary');
    c.min_salary_lpa = n;
    writeFileSync(path, JSON.stringify(c, null, 2));
    setKv('onboard', 'done');
    say('👍 Saved. A few standard questions next, the ones almost every application asks. Answer each with Reply; I remember them for every future application.');
    // Restart this agent so the job search schedules start with the new profile; it asks the setup questions on start.
    setTimeout(() => { spawn('sh', [join(ROOT, 'scripts', 'run.sh'), 'people'], { detached: true, stdio: 'ignore' }).unref(); }, 3000);
    return;
  }
}
