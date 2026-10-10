// Asking the owner: one WhatsApp message per new question; the answer is remembered forever and
// unblocks every application or email draft that was waiting on it.
import { one, all, run, event } from './db.mjs';
import { unanswered, remember } from './answers.mjs';
import { tell } from './whatsapp.mjs';

export function askOwner(question, { jobId = null, draftId = null, context = '', kind = 'text', options = null } = {}) {
  const q = unanswered(question, { kind, options, source: context });
  if (q.answer) return q.id;
  const alreadyAsked = one("SELECT 1 FROM asks WHERE question_id = ? AND status = 'open'", q.id);
  run('INSERT INTO asks(question_id, job_id, thread_id, asked_at) VALUES(?,?,?,?)', q.id, jobId, draftId ? `draft:${draftId}` : null, Date.now());
  if (!alreadyAsked) {
    const opts = q.options ? `\nOptions: ${JSON.parse(q.options).join(' / ')}` : '';
    tell(`❓ Q${q.id}: ${q.question}${opts}\n(${context})\n\n— Reply to this message with your answer. I'll remember it for every future application.`,
      { refKind: 'question', refId: q.id, options: q.options ? JSON.parse(q.options) : null });
  }
  return q.id;
}

/** Store the owner's answer and return what got unblocked: {jobs: [...ids], drafts: [...ids]}. */
export function answerQuestion(questionId, text) {
  const q = one('SELECT * FROM questions WHERE id = ?', questionId);
  if (!q) return null;
  remember(q.question, text.trim(), 'owner');
  const open = all("SELECT * FROM asks WHERE question_id = ? AND status = 'open'", questionId);
  run("UPDATE asks SET status = 'answered' WHERE question_id = ? AND status = 'open'", questionId);
  event('answer', `Q${questionId} ${q.question} → ${text.trim()}`);

  const jobs = [...new Set(open.map((a) => a.job_id).filter(Boolean))].filter((id) =>
    !one("SELECT 1 FROM asks WHERE job_id = ? AND status = 'open'", id));
  for (const id of jobs) run("UPDATE jobs SET status = 'queued', status_note = 'answers received' WHERE id = ? AND status = 'needs_answer'", id);

  const drafts = [...new Set(open.map((a) => a.thread_id).filter((t) => t?.startsWith('draft:')).map((t) => +t.slice(6)))].filter((d) =>
    !one("SELECT 1 FROM asks WHERE thread_id = ? AND status = 'open'", `draft:${d}`));
  return { jobs, drafts };
}

export const openQuestions = () => all(`SELECT q.id, q.question, count(a.id) AS waiting FROM questions q JOIN asks a ON a.question_id = q.id
  WHERE a.status = 'open' GROUP BY q.id ORDER BY q.id`);
