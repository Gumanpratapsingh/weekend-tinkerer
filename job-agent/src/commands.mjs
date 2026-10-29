// What the agent does with each WhatsApp message from the owner.
import { one, all, run, setKv } from './db.mjs';
import { answerQuestion, openQuestions } from './asks.mjs';
import { composeDraft, sendDraft } from './mail.mjs';
import { todayStats } from './apply.mjs';
import { tell, cardDone } from './whatsapp.mjs';
import { ncrOn, ncrAuto, ncrAutoOn, isNcr, ncrSweep, ncrNotify, ncrAction, ncrAfterAnswer } from './ncr.mjs';
import { asideList } from './referrals.mjs';

const HELP = `Job agent commands:
• status — today's numbers
• jobs — top jobs waiting to be applied
• manual — jobs you need to apply to yourself
• questions — questions waiting for you
• memory — what I've learned about you
• forget <Q-number> — delete an answer
• pause / resume — stop or restart applying
• go live / dry run — submit for real, or only fill forms
• review on / off — show me each filled application first, sent only when you tap ✓ Submit
• ncr — best Gurgaon/Noida jobs · ncr aside — companies with nobody on LinkedIn · ncr referrals on/off — automatic connection requests · ncr auto on/off — I apply to NCR jobs myself · ncr on/off — the whole NCR watch (details: type help in the 📍 chat)
Reply to any ❓ message to answer it, or to a ✍️ draft with ok / no / your own text.`;

export async function onAnswered(qid, text) {
  const r = answerQuestion(qid, text);
  if (!r) return tell(`I don't have a question Q${qid}.`);
  cardDone('question', qid, `Answered: ${text}`);
  for (const d of r.drafts) await composeDraft(d);
  const left = openQuestions().length;
  tell(`✅ Saved Q${qid}.${r.jobs.length ? ` ${r.jobs.length} application(s) back in the queue.` : ''}${left ? ` ${left} question(s) still open.` : ''}`);
  ncrAfterAnswer().catch(() => {});                       // NCR fill-and-show jobs waiting on this answer fill again
}

export async function handleOwner(text, ref) {
  const t = text.trim();
  const lc = t.toLowerCase();

  if (ref?.ref_kind === 'ncrjob' || ref?.ref_kind === 'ncrsubmit') return ncrAction(ref, t);
  if (ref?.ref_kind === 'interview') {
    const job = one('SELECT * FROM jobs WHERE id = ?', ref.ref_id);
    if (!job) return tell(`No job ${ref.ref_id} on file anymore.`);
    run("UPDATE jobs SET status_note = status_note || ' (acknowledged)' WHERE id = ?", ref.ref_id);
    cardDone('interview', ref.ref_id, '✓ Acknowledged');
    return;
  }
  if (ref?.ref_kind === 'question') return onAnswered(+ref.ref_id, t);
  if (ref?.ref_kind === 'referral') {
    const { decide } = await import('./referrals.mjs');
    return tell(decide(+ref.ref_id, t));
  }
  if (ref?.ref_kind === 'emailapp') {
    const { decideEmailApp } = await import('./emailapply.mjs');
    return tell(await decideEmailApp(+ref.ref_id, t).catch((e) => `Couldn't send that email (${e.message.slice(0, 100)}).`));
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
    case 'review on': setKv('review_mode', '1'); return tell('👀 Review on: I fill each application and send you the screenshots and answers first. Nothing is sent until you tap ✓ Submit.');
    case 'review off': setKv('review_mode', '0'); return tell('🚀 Review off: I submit applications myself again (you still get "what I sent" after each one).');
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
    case 'ncr referrals off': setKv('ncr_ref_off', '1'); return tell('🤝 Automatic connection requests for NCR jobs off (the 🤝 button on job cards still works).');
    case 'ncr referrals on': setKv('ncr_ref_off', '0'); return tell('🤝 Automatic connection requests on: plain requests (no message) to people who could refer you at NCR companies, one job an hour in the daytime. Your referral message still waits for your OK.');
    case 'ncr aside': {
      const rows = asideList();
      return tell(rows.length ? `🗂 Kept aside (nobody found on LinkedIn):\n${rows.map((r) => `• ${r.company} — ${r.job_title}\n  ${r.job_url}`).join('\n')}` : '🗂 Nothing kept aside yet.');
    }
    case 'ncr off': setKv('ncr_off', '1'); return tell('📍 Gurgaon/Noida watch off: NCR jobs go back to the normal queue (applied automatically).');
    case 'ncr auto on': { const n = ncrAutoOn(); return tell(`⚡ NCR auto-apply on: I keep searching Gurgaon/Noida and apply to good matches myself, no cards.${n ? ` ${n} waiting card(s) moved to the queue.` : ''} Send "ncr auto off" to get cards again.`, { chat: 'ncr' }); }
    case 'ncr auto off': setKv('ncr_auto', '0'); return tell('📍 NCR auto-apply off: NCR matches not applied to yet come back here as cards (except ones you queued yourself).', { chat: 'ncr' });
    case 'ncr on': setKv('ncr_off', '0'); ncrSweep(); await ncrNotify(); return tell('📍 Gurgaon/Noida watch on: NCR jobs come here as links, I won\'t apply to them.');
    case 'ncr': {
      const rows = all("SELECT title, company, score, location, apply_url FROM jobs WHERE status = 'manual' ORDER BY score DESC LIMIT 60").filter(isNcr).slice(0, 10);
      return tell(`${ncrOn() ? `📍 Watch on${ncrAuto() ? ', auto-apply on' : ''}.` : '📍 Watch off (send "ncr on").'}${rows.length ? `\nBest Gurgaon/Noida jobs to apply to:\n${rows.map((r) => `• ${r.score}% ${r.title} @ ${r.company} (${r.location})\n  ${r.apply_url}`).join('\n')}` : '\nNone waiting right now.'}`);
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
