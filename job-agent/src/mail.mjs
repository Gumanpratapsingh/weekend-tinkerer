// Mailbox watcher: reads new mail over IMAP, picks out recruiter/job mail, tells the owner on WhatsApp,
// answers questions from memory, and drafts replies. Nothing is sent until the owner says "ok".
// Secret: ~/.jobagent/gmail_app_password (Google account -> Security -> App passwords; needs 2-Step Verification).
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import { config, secret, llm, log, master } from './core.mjs';
import { one, all, run, getKv, setKv, event, norm } from './db.mjs';
import { resolve } from './answers.mjs';
import { tell } from './whatsapp.mjs';
import { askOwner } from './asks.mjs';

const JOBBY = /\b(application|applied|interview|candidate|candidature|position|role|opening|opportunit|recruit|hiring|talent|assessment|assignment|coding test|hackerrank|offer|shortlist|regret|unfortunately|next steps|availability|resume|cv|ctc|notice period)\b/i;
const NOISE = /\b(job alert|jobs for you|recommended jobs|newsletter|unsubscribe from job alerts|people also viewed|weekly digest)\b/i;
export const mailConfigured = () => !!secret('gmail_app_password');

function client() {
  return new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, logger: false,
    auth: { user: config().mailbox, pass: secret('gmail_app_password') } });
}

export async function checkMail() {
  if (!mailConfigured()) return;
  const imap = client();
  await imap.connect();
  try {
    const lock = await imap.getMailboxLock('INBOX');
    try {
      let last = Number(getKv('mail_uid', 0));
      if (!last) {                                      // first run: start from mail of the last 2 days
        const uids = await imap.search({ since: new Date(Date.now() - 2 * 86400e3) }, { uid: true });
        last = uids.length ? Math.min(...uids) - 1 : (imap.mailbox.uidNext - 1);
      }
      for await (const msg of imap.fetch(`${last + 1}:*`, { uid: true, source: true }, { uid: true })) {
        if (msg.uid <= last) continue;
        try { await handle(await simpleParser(msg.source)); } catch (e) { log(`mail ${msg.uid}: ${e.message}`); }
        setKv('mail_uid', msg.uid);
      }
    } finally { lock.release(); }
  } finally { await imap.logout().catch(() => {}); }
}

function linkJob(company, fromAddr) {
  const domain = String(fromAddr).split('@')[1]?.split('.').slice(-2, -1)[0] || '';
  const applied = all("SELECT id, company, title FROM jobs WHERE status IN ('applied','interview','needs_answer','manual') ORDER BY applied_at DESC LIMIT 400");
  const c = norm(company || '');
  return applied.find((j) => c && (norm(j.company).includes(c) || c.includes(norm(j.company))))
      || applied.find((j) => domain.length > 3 && norm(j.company).replace(/ /g, '').includes(domain));
}

async function handle(mail) {
  const id = mail.messageId || `${mail.date?.getTime()}-${mail.subject}`;
  if (one('SELECT 1 FROM emails WHERE id = ?', id)) return;
  const from = mail.from?.value?.[0]?.address || '';
  const text = (mail.text || '').replace(/\n>.*$/gms, '').slice(0, 6000);   // drop quoted history
  const known = all('SELECT DISTINCT company FROM jobs WHERE applied_at IS NOT NULL').some((j) => from.includes(norm(j.company).split(' ')[0]));
  if (!known && (!JOBBY.test(`${mail.subject} ${text.slice(0, 1500)}`) || NOISE.test(`${mail.subject} ${text.slice(0, 600)}`))) return;

  const c = await llm([
    { role: 'system', content: `Classify an email received by a job seeker. Return JSON:
{"job_related":bool,"category":"interview|question|assessment|rejection|offer|confirmation|other",
 "company":"", "role":"", "summary":"<=30 words, include dates/times/links that matter",
 "questions":["each thing the sender asks the candidate to tell/confirm/share, as a standalone question"],
 "needs_reply":bool, "urgent":bool}
"confirmation" = automatic "we received your application". Job alerts/marketing are job_related=false.` },
    { role: 'user', content: `From: ${mail.from?.text}\nSubject: ${mail.subject}\nDate: ${mail.date?.toISOString()}\n\n${text}` },
  ], { json: true, maxTokens: 600, temperature: 0, why: `reading an email from ${from}` });
  if (!c.job_related) return;

  const job = linkJob(c.company, from);
  run('INSERT INTO emails(id, thread_id, job_id, direction, from_addr, to_addr, subject, body, category, at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    id, (mail.references?.[0] || mail.inReplyTo || id), job?.id || null, 'in', from, config().mailbox, mail.subject || '', text, c.category, Date.now());
  const label = `${c.company || job?.company || from}${c.role ? ` · ${c.role}` : ''}`;
  event(c.category, `${label}: ${c.summary}`);

  if (job && ['interview', 'assessment', 'offer'].includes(c.category)) run("UPDATE jobs SET status = 'interview', status_note = ? WHERE id = ?", c.summary, job.id);
  if (job && c.category === 'rejection') run("UPDATE jobs SET status = 'rejected', status_note = ? WHERE id = ?", c.summary, job.id);

  const icon = { interview: '🎉 Interview', assessment: '📝 Assessment', offer: '🏆 Offer', question: '❓ Recruiter question', rejection: '✖️ Rejection', confirmation: '📨 Received', other: '✉️ Email' }[c.category] || '✉️ Email';
  if (c.category !== 'confirmation' && c.category !== 'rejection') {
    tell(`${icon} — ${label}\n${c.summary}\nFrom: ${from}`, { urgent: ['interview', 'offer'].includes(c.category) || c.urgent });
  }

  const noReply = /no-?reply|do-?not-?reply|notifications?@|mailer/i.test(from);
  if (!c.needs_reply || noReply || !c.questions?.length) return;

  const items = c.questions.slice(0, 10).map((q, i) => ({ key: `q${i}`, label: q, type: 'text' }));
  const { answers, unknown } = await resolve(items, `Recruiter email from ${label}`);
  run('INSERT INTO drafts(email_id, body, status, created_at) VALUES(?,?,?,?)', id, JSON.stringify({ items, answers }), 'waiting', Date.now());
  const draftId = one('SELECT max(id) AS id FROM drafts').id;
  for (const it of unknown) askOwner(it.label, { draftId, context: `${label} asked by email` });
  if (!unknown.length) await composeDraft(draftId);
}

// Called when every question of a draft has an answer: write the reply and ask the owner to approve it.
export async function composeDraft(draftId) {
  const d = one('SELECT * FROM drafts WHERE id = ?', draftId);
  if (!d || d.status !== 'waiting') return;
  const { items } = JSON.parse(d.body);
  const { answers, unknown } = await resolve(items);
  if (unknown.length) return;
  const mail = one('SELECT * FROM emails WHERE id = ?', d.email_id);
  const me = master();
  const body = await llm([
    { role: 'system', content: `Write a short, polite, professional email reply from ${me.name} to a recruiter.
Answer each question using ONLY the given answers. No placeholders, no promises not in the answers, no subject line.
Sign off as "Regards,\\n${me.name}\\n${me.contact.phone}".` },
    { role: 'user', content: `THEIR EMAIL:\n${mail.body.slice(0, 3000)}\n\nANSWERS:\n${items.map((it) => `${it.label} -> ${answers[it.key]}`).join('\n')}` },
  ], { maxTokens: 600, temperature: 0.3, why: 'drafting a reply to a recruiter' });
  run("UPDATE drafts SET body = ?, status = 'pending' WHERE id = ?", body, draftId);
  tell(`✍️ Draft reply #${draftId} to ${mail.from_addr}\nRe: ${mail.subject}\n\n${body}\n\n— Reply to this message with *ok* to send, *no* to discard, or type the exact text to send instead.`,
    { refKind: 'draft', refId: draftId, urgent: true });
}

export async function sendDraft(draftId, overrideBody) {
  const d = one('SELECT * FROM drafts WHERE id = ?', draftId);
  if (!d || !['pending', 'waiting'].includes(d.status)) return 'That draft is no longer open.';
  const mail = one('SELECT * FROM emails WHERE id = ?', d.email_id);
  const body = overrideBody || d.body;
  const smtp = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true,
    auth: { user: config().mailbox, pass: secret('gmail_app_password') } });
  const subject = /^re:/i.test(mail.subject) ? mail.subject : `Re: ${mail.subject}`;
  const info = await smtp.sendMail({ from: `${master().name} <${config().mailbox}>`, to: mail.from_addr, subject, text: body,
    inReplyTo: mail.id, references: [mail.thread_id, mail.id].filter(Boolean).join(' ') });
  run("UPDATE drafts SET status = 'sent', body = ?, sent_at = ? WHERE id = ?", body, Date.now(), draftId);
  run('INSERT INTO emails(id, thread_id, job_id, direction, from_addr, to_addr, subject, body, category, at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    info.messageId, mail.thread_id, mail.job_id, 'out', config().mailbox, mail.from_addr, subject, body, 'reply', Date.now());
  event('reply', `Replied to ${mail.from_addr}: ${subject}`);
  return `✅ Sent to ${mail.from_addr}.`;
}
