// Jobs that take applications by email (a company page says "send your resume to jobs@…", or its Apply link is a
// mailto:). The agent drafts a short application email from the resume facts, with the resume attached, and sends it
// only after the person taps Send in Cupboard (or types their own text to send instead). Nothing goes out unapproved.
import nodemailer from 'nodemailer';
import { existsSync } from 'node:fs';
import { llm, master, persona, config, secret, log, activity, resumeFile, yearsWorked } from './core.mjs';
import { one, run, event } from './db.mjs';
import { tell, cardDone } from './whatsapp.mjs';

run(`CREATE TABLE IF NOT EXISTS email_apps (id INTEGER PRIMARY KEY, job_id TEXT NOT NULL, to_addr TEXT NOT NULL, subject TEXT NOT NULL,
  body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, sent_at INTEGER)`);

const mailReady = () => !!(secret('gmail_app_password') && config().mailbox);

async function compose(job) {
  const m = master(), P = persona(), years = Math.floor(yearsWorked());
  const fallback = `Dear Hiring Team,\n\nI would like to apply for the ${job.title} role at ${job.company}. `
    + `${P.pitch ? `${P.pitch.replace(/\.$/, '')}. ` : ''}I have ${years}+ years of full-time experience as ${m.experience[0]?.title} at ${m.experience[0]?.org}. `
    + `My resume is attached.\n\nThank you for your time. I look forward to hearing from you.\n\nRegards,\n${m.name}\n${m.contact.phone}\n${m.contact.email}`;
  try {
    const text = await llm([
      { role: 'system', content: 'Write a short job application email body (90-140 words) in first person, plain text, no subject line. '
        + 'Use ONLY the FACTS given: never invent skills, numbers or employers. Mention the role and company, 2-3 relevant facts, '
        + 'that the resume is attached, and end with the sign-off block exactly as given.' },
      { role: 'user', content: `ROLE: ${job.title} at ${job.company}\nJOB (excerpt): ${String(job.description || '').slice(0, 1500)}\n\n`
        + `FACTS:\n${m.experience.map((e) => `${e.title} @ ${e.org} (${e.dates}): ${e.bullets.map((b) => b.text).join(' ')}`).join('\n')}\n`
        + `Skills: ${Object.values(m.skills).flat().join(', ')}\nFull-time experience: ${years}+ years\n\n`
        + `SIGN-OFF:\nRegards,\n${m.name}\n${m.contact.phone}\n${m.contact.email}` },
    ], { maxTokens: 500, temperature: 0.3, why: `drafting an email application for ${job.title} @ ${job.company}` });
    return text && text.length > 80 ? text.trim() : fallback;
  } catch { return fallback; }
}

/** The applier found that this job applies by email: draft it and ask for approval. Returns the job status set. */
export async function draftEmailApp(job, { email, subject }) {
  const label = `${job.title} @ ${job.company}`;
  if (!mailReady()) {
    run("UPDATE jobs SET status = 'manual', status_note = ? WHERE id = ?", `apply by email to ${email} (Gmail not connected)`, job.id);
    tell(`✉️ ${label} takes applications by email: send your resume to ${email}. (Connect Gmail and I'll draft these for you.)`, { refKind: 'job', refId: job.id });
    return;
  }
  const subj = subject || `Application for ${job.title} – ${master().name}`;
  const body = await compose(job);
  run('INSERT INTO email_apps(job_id, to_addr, subject, body, created_at) VALUES(?,?,?,?,?)', job.id, email, subj, body, Date.now());
  const id = one('SELECT max(id) id FROM email_apps').id;
  run("UPDATE jobs SET status = 'manual', status_note = ? WHERE id = ?", `email application to ${email}: waiting for your OK`, job.id);
  activity(`✉️ ${label}: applies by email to ${email} — drafted, waiting for your OK`);
  tell(`✉️ Email application #${id}: ${label} (${job.score}%)\nTo: ${email}\nSubject: ${subj}\nAttached: your resume\n\n${body}\n\n— Send, Discard, or reply with your own text to send instead.`,
    { refKind: 'emailapp', refId: id });
}

/** Send / Discard / custom text from Cupboard. */
export async function decideEmailApp(id, text) {
  const a = one('SELECT * FROM email_apps WHERE id = ?', id);
  if (!a || a.status !== 'pending') return 'That email application is no longer open.';
  const job = one('SELECT * FROM jobs WHERE id = ?', a.job_id);
  const t = String(text).trim();
  if (/^(no|discard|skip|cancel)$/i.test(t)) {
    run("UPDATE email_apps SET status = 'discarded' WHERE id = ?", id);
    run("UPDATE jobs SET status = 'skipped', status_note = 'email application discarded by you' WHERE id = ?", a.job_id);
    cardDone('emailapp', id, 'Discarded');
    return `🗑 Discarded the email to ${a.to_addr}.`;
  }
  const body = /^(ok|okay|yes|send|👍)$/i.test(t) ? a.body : t;
  const resume = job?.resume_path && existsSync(job.resume_path) ? job.resume_path : resumeFile();
  const smtp = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: config().mailbox, pass: secret('gmail_app_password') } });
  const info = await smtp.sendMail({ from: `${master().name} <${config().mailbox}>`, to: a.to_addr, subject: a.subject, text: body,
    attachments: [{ filename: `${master().name.replace(/\s+/g, '_')}_Resume.pdf`, path: resume }] });
  run("UPDATE email_apps SET status = 'sent', body = ?, sent_at = ? WHERE id = ?", body, Date.now(), id);
  run("UPDATE jobs SET status = 'applied', applied_at = ?, status_note = ? WHERE id = ?", Date.now(), `applied by email to ${a.to_addr}`, a.job_id);
  run('INSERT OR IGNORE INTO emails(id, thread_id, job_id, direction, from_addr, to_addr, subject, body, category, at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    info.messageId, info.messageId, a.job_id, 'out', config().mailbox, a.to_addr, a.subject, body, 'application', Date.now());
  event('applied', `${job?.title} @ ${job?.company} (by email to ${a.to_addr})`);
  log(`email application ${id} sent to ${a.to_addr}`);
  cardDone('emailapp', id, 'Sent ✓');
  return `✅ Applied by email to ${a.to_addr}.`;
}
