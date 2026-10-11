// What the agent does with each WhatsApp message from the owner.
import { one, all, run, setKv } from './db.mjs';
import { answerQuestion, openQuestions } from './asks.mjs';
import { composeDraft, sendDraft } from './mail.mjs';
import { todayStats } from './apply.mjs';
import { tell } from './whatsapp.mjs';

const HELP = `Job agent commands:
• status — today's numbers
• jobs — top jobs waiting to be applied
• manual — jobs you need to apply to yourself
• questions — questions waiting for you
• memory — what I've learned about you
• forget <Q-number> — delete an answer
• pause / resume — stop or restart applying
• go live / dry run — submit for real, or only fill forms
Reply to any ❓ message to answer it, or to a ✍️ draft with ok / no / your own text.`;

export async function onAnswered(qid, text) {
  const r = answerQuestion(qid, text);
  if (!r) return tell(`I don't have a question Q${qid}.`);
  for (const d of r.drafts) await composeDraft(d);
  const left = openQuestions().length;
  tell(`✅ Saved Q${qid}.${r.jobs.length ? ` ${r.jobs.length} application(s) back in the queue.` : ''}${left ? ` ${left} question(s) still open.` : ''}`);
}

export async function handleOwner(text, ref) {
  const t = text.trim();
  const lc = t.toLowerCase();

  if (ref?.ref_kind === 'question') return onAnswered(+ref.ref_id, t);
  if (ref?.ref_kind === 'referral') {
    const { decide } = await import('./referrals.mjs');
    return tell(decide(+ref.ref_id, t));
  }
  if (ref?.ref_kind === 'draft') {
    if (/^(ok|okay|yes|send|👍)$/i.test(t)) return tell(await sendDraft(+ref.ref_id));
    if (/^(no|discard|cancel|skip)$/i.test(t)) { run("UPDATE drafts SET status = 'discarded' WHERE id = ?", +ref.ref_id); return tell('🗑 Draft discarded.'); }
    return tell(await sendDraft(+ref.ref_id, t));                // owner typed the exact reply
  }

  const qm = /^q(\d+)[:\s]+([\s\S]+)$/i.exec(t);
  if (qm) return onAnswered(+qm[1], qm[2]);
  const fm = /^forget\s+q?(\d+)$/i.exec(t);
  if (fm) { run('UPDATE questions SET answer = NULL WHERE id = ?', +fm[1]); return tell(`Forgot Q${fm[1]}. I'll ask again next time it comes up.`); }

  switch (lc) {
    case 'hi': case 'hello': case 'hey': return tell(`👋 I'm here. ${openQuestions().length} open question(s). Send "help" for commands.`);
    case 'help': return tell(HELP);
    case 'go live': setKv('dry_run', '0'); run("UPDATE jobs SET status = 'queued' WHERE status = 'ready'"); return tell('🚀 Live: I will now submit applications (fit ≥ min score, within daily caps).');
    case 'dry run': setKv('dry_run', '1'); return tell('🧪 Dry run: I fill forms but never submit.');
    case 'pause': setKv('paused', '1'); return tell('⏸ Paused applying. I still watch your mail. Send "resume" to restart.');
    case 'resume': setKv('paused', '0'); return tell('▶️ Applying again.');
    case 'status': case 'today': {
      const s = todayStats();
      return tell(`📊 Today: found ${s.found}, good matches ${s.matched}, applied ${s.applied}.\nQueue ${s.queued} · waiting on you ${s.waiting} · apply-yourself ${s.manual}\nAll time: ${s.appliedTotal} applied, ${s.interviews} in interview stage.`);
    }
    case 'jobs': {
      const rows = all("SELECT title, company, score FROM jobs WHERE status = 'queued' ORDER BY score DESC LIMIT 8");
      return tell(rows.length ? `Next up:\n${rows.map((r) => `• ${r.score}% ${r.title} @ ${r.company}`).join('\n')}` : 'Queue is empty.');
    }
    case 'manual': {
      const rows = all("SELECT title, company, score, apply_url FROM jobs WHERE status = 'manual' ORDER BY found_at DESC LIMIT 8");
      return tell(rows.length ? `Apply to these yourself:\n${rows.map((r) => `• ${r.score}% ${r.title} @ ${r.company}\n  ${r.apply_url}`).join('\n')}` : 'Nothing waiting for you.');
    }
    case 'questions': {
      const q = openQuestions();
      return tell(q.length ? `Open questions (answer with "Q<number> <answer>"):\n${q.map((x) => `Q${x.id}: ${x.question}`).join('\n')}` : 'No open questions 🎉');
    }
    case 'memory': {
      const rows = all('SELECT id, question, answer FROM questions WHERE answer IS NOT NULL ORDER BY updated_at DESC LIMIT 40');
      return tell(rows.length ? `What I know (newest first):\n${rows.map((r) => `Q${r.id} ${r.question} → ${r.answer}`).join('\n')}` : 'Nothing yet.');
    }
  }

  // Plain text with exactly one open question: treat it as the answer.
  const open = openQuestions();
  if (open.length === 1) return onAnswered(open[0].id, t);
  if (open.length > 1) return tell(`Which question is that for? Swipe-reply to the ❓ message, or send "Q<number> <answer>". Send "questions" to list them.`);
  return tell(HELP);
}
