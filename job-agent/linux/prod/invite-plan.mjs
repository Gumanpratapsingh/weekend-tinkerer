// Prints the invite page's "what your job agent will do" (JSON) for people/<name>, from that person's real settings, so the
// page can't promise anything the agent doesn't do. Run as the prod user by add-person.sh.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const name = process.argv[2];
if (!/^[a-z][a-z0-9_-]{0,30}$/.test(name || '')) { console.error('usage: invite-plan.mjs <name>'); process.exit(1); }
const read = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
const J = join(homedir(), 'jobagent'), P = join(J, 'people', name, 'profile');
const c = { ...read(join(J, 'profile', 'config.json'), {}), ...read(join(P, 'config.json'), {}) };
const m = read(join(P, 'master.json'), null);
let runBy = 'Guman'; try { runBy = readFileSync(join(homedir(), 'cupboard', 'run-by'), 'utf8').trim() || runBy; } catch { /* just the owner */ }

// Search terms are lowercase in the settings: show them as people write them.
const SPECIAL = { aws: 'AWS', gcp: 'GCP', sre: 'SRE', devops: 'DevOps', qa: 'QA', vp: 'VP', sde: 'SDE' };
const nice = (t) => t.trim().split(/\s+/).map((w) => SPECIAL[w.toLowerCase()] || w[0].toUpperCase() + w.slice(1)).join(' ');
const first = m?.name ? m.name.split(/\s+/)[0].toLowerCase().replace(/^./, (x) => x.toUpperCase()) : '';
const roles = c.tracks?.backend?.queries || [];
const caps = c.daily_caps || { naukri: 25, linkedin: 10, ats: 20, total: 55, per_company: 3 };
const min = c.min_score ?? 65, tailor = c.tailor_min_score ?? 75, skip = c.title_exclude || [], no = c.exclude_companies || [];
const cities = c.locations_confirmed ? [...(c.locations?.preferred || []), ...(c.locations?.other_cities || [])] : null;

console.log(JSON.stringify({
  title: `${first ? `${first}, your` : 'Your'} job agent`,
  intro: 'Guman is setting up a job agent for you. It finds jobs and applies from your own accounts, so please read what it will do before you join. Nothing is submitted until you say so.',
  accept: 'I understand, create my account',
  sections: [
    { heading: 'Roles it will apply to', items: roles.length ? roles.map(nice) : ['Chosen from your resume during setup.'], note: 'You can change this list during setup.' },
    { heading: 'Which jobs it picks', items: [
      cities ? `Cities: ${cities.join(', ')}.` : 'Cities: you choose during setup (any Indian city, specific ones, and/or remote).',
      'Salary: you set your minimum during setup. Jobs that state less are skipped.',
      c.experience_years ? `Experience: matched to your ${c.experience_years} years. Jobs clearly asking for much more are skipped.` : 'Experience: matched to your resume.',
      `Fit: AI scores each job against your resume and only applies at ${min}% or higher.`,
      ...(skip.length ? [`Job titles it skips: ${skip.map(nice).join(', ')}.`] : []),
      ...(no.length ? [`Companies it never applies to: ${no.map(nice).join(', ')}.`] : []),
    ] },
    { heading: 'Where it applies, and how much', items: [
      `LinkedIn: up to ${caps.linkedin} a day, from your account.`,
      `Naukri: up to ${caps.naukri} a day, from your account.`,
      `Company career sites: up to ${caps.ats} a day.`,
      `At most ${caps.total} applications a day, and ${caps.per_company} per company.`,
    ], note: 'These are limits, not targets. Real numbers depend on how many jobs fit.' },
    { heading: 'What it does in your name', items: [
      'Fills application forms using only your resume and answers you gave it. Anything it doesn\'t know, it asks you in chat.',
      c.original_resume_only ? 'It attaches your resume exactly as you gave it, on every application. It is never edited.'
        : `For ${tailor}%+ matches on LinkedIn and company sites, it tailors your resume for that job, using only facts already on it.`,
      'On Naukri it uses your resume as uploaded, and re-uploads it twice a day so your profile shows as recently updated.',
      'Reads your job emails: confirmations, recruiter replies, interview invites and security codes for applications.',
      'Drafts recruiter replies, emailed applications and LinkedIn referral messages. These go out only after you approve each one.',
    ] },
    { heading: 'You stay in control', items: [
      'It starts in dry run: forms are filled but never submitted.',
      'When you send "go live", the first two weeks still need your tap: you see each application and press Submit or Cancel.',
      'After that it submits on its own. Send "pause" anytime to stop, "resume" to restart.',
      'You check every detail it read from your resume before anything is used.',
    ] },
    { heading: 'What you\'ll need to give it', items: [
      m ? 'Your resume: Guman already added it. You\'ll review it in chat.' : 'Your resume, as a PDF.',
      ...(c.keys_by_owner ? [] : ['Two free AI keys, one from Google Gemini and one from Groq. You create them; no card needed.']),
      'A Gmail app password for your job mailbox (mail access only, you can delete it anytime).',
      'LinkedIn and Naukri sign-in: you type into the real site and only the signed-in session is kept, not your password. If that doesn\'t work, Guman may ask for your login and any OTP to sign in for you. Change your password afterwards; the session stays signed in.',
    ] },
    { heading: 'Who can see your data', items: [
      'It runs on a laptop at Guman\'s home. Chats and data are stored there and are not end-to-end encrypted.',
      `${runBy} run${/ and /.test(runBy) ? '' : 's'} this and can see your applications, answers, agent chat, sign-ins, activity in the app, and stored logins. Other users can't.`,
      `Your resume details and job descriptions are sent to Gemini and Groq, under ${c.keys_by_owner ? 'keys Guman provides' : 'your own keys'}, for scoring and tailoring.`,
      'Want out? Ask Guman and your agent and data get deleted. Also remove the Gmail app password yourself.',
    ] },
    { heading: 'Worth knowing before you say yes', items: [
      'LinkedIn and Naukri don\'t officially allow automated applying, so your accounts could be limited or restricted.',
      'It can make mistakes on a form. Look through what it sent, especially at first.',
    ] },
  ],
}));
