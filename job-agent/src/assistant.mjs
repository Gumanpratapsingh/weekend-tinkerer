// Free-form questions from the owner (via Cupboard): answered by the LLM from the agent's live state.
// Read-only: it explains and reports; it never changes anything.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { llm, config, ROOT, HOME } from './core.mjs';
import { one, all, getKv } from './db.mjs';

const HOW = `How the job agent works (for explaining "why" questions):
- Runs on the owner's S20 phone 24/7. Finds jobs on Naukri, LinkedIn, company career boards (Greenhouse/Lever/Ashby/SmartRecruiters) and free feeds.
- Each job gets an AI fit score; >= min_score is queued and applied to. Naukri uses his original profile resume; LinkedIn and company sites get a tailored resume (facts only).
- Pacing to avoid bans: Naukri ~50/day 3-6 min apart 8AM-11PM; LinkedIn ~20/day 9AM-9PM; company sites ~40/day. One browser, one task at a time.
- Form questions are answered from his saved answers + resume facts. Anything personal it doesn't know (e.g. CGPA, consent, NDA, address, relatives) is asked to him; the job waits as "needs_answer" until he replies.
- CAPTCHAs are never bypassed: those jobs wait for him to finish on the Mac (scripts/finish.sh). Sites that need an account (Workday, Taleo, Oracle) go to "apply yourself".
- Free AI quota (Groq + Gemini) can run out; then work pauses and retries ("rate limited").
- A thermal guard pauses the browser if the phone gets hot. Inbox is checked every few hours; recruiter replies are drafted and need his OK.
- Referral outreach drafts LinkedIn invites/messages that always wait for his Send.
Statuses: new (unscored), scored (below threshold), queued, applying, ready (dry run), needs_answer, captcha, manual (apply yourself), claimed, applied, interview, rejected, failed, skipped, filtered.`;

function context() {
  const day = Date.parse(`${new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10)}T00:00:00+05:30`);
  const n = (sql, ...p) => one(sql, ...p)?.n ?? 0;
  const byStatus = all('SELECT status, count(*) n FROM jobs GROUP BY status').map((r) => `${r.status}=${r.n}`).join(' ');
  const applied = all('SELECT title, company, source FROM jobs WHERE applied_at >= ? ORDER BY applied_at', day).map((r) => `${r.title} @ ${r.company} (${r.source})`);
  const failed = all(`SELECT a.status, a.reason, j.title, j.company FROM attempts a LEFT JOIN jobs j ON j.id = a.job_id
    WHERE a.status != 'applied' ORDER BY a.at DESC LIMIT 15`).map((r) => `${r.title} @ ${r.company}: ${r.status} ${String(r.reason || '').slice(0, 120)}`);
  const questions = all(`SELECT q.id, q.question, count(a.id) n FROM questions q JOIN asks a ON a.question_id = q.id WHERE a.status = 'open' GROUP BY q.id`)
    .map((r) => `Q${r.id} (${r.n} job(s) waiting): ${r.question}`);
  const events = all('SELECT at, kind, text FROM events ORDER BY id DESC LIMIT 25').map((r) => `${new Date(r.at + 5.5 * 3600e3).toISOString().slice(5, 16)} ${r.kind}: ${String(r.text).slice(0, 140)}`);
  let errors = [];
  try { errors = readFileSync(join(ROOT, 'data', 'errors.jsonl'), 'utf8').trim().split('\n').slice(-60).map((l) => JSON.parse(l))
    .filter((r) => Date.now() - Date.parse(r.at) < 864e5).map((r) => `${r.kind}: ${String(r.message).slice(0, 120)}`); } catch { /* none */ }
  const errCounts = {}; for (const e of errors) errCounts[e] = (errCounts[e] || 0) + 1;
  const ref = all('SELECT stage, count(*) n FROM referrals WHERE person IS NOT NULL GROUP BY stage').map((r) => `${r.stage}=${r.n}`).join(' ');
  let phone = ''; try { const s = JSON.parse(readFileSync(join(HOME, 'live', 'status.json'), 'utf8')); phone = `battery ${s.battery}% ${s.batteryStatus}, battery ${s.batteryTempC}°C, CPU ${s.cpuTempC}°C`; } catch { /* none */ }
  const now = JSON.parse(getKv('now') || 'null');
  return [
    `Now: ${now?.text || 'idle'} | paused=${getKv('paused') === '1'} | dry_run=${getKv('dry_run', '1') === '1'} | cooling=${getKv('thermal_pause') === '1'} | phone: ${phone}`,
    `Min fit score ${config().min_score}; salary floor ${config().min_salary_lpa} LPA; inbox every ${config().mail_check_hours} h.`,
    `Jobs by status: ${byStatus}`,
    `Applied today (${applied.length}): ${applied.join('; ') || 'none yet'}`,
    `All-time applied: ${n('SELECT count(*) n FROM jobs WHERE applied_at IS NOT NULL')}; interviews: ${n("SELECT count(*) n FROM jobs WHERE status = 'interview'")}`,
    `Open questions for the owner:\n${questions.join('\n') || 'none'}`,
    `Recent attempts that did not apply:\n${failed.join('\n') || 'none'}`,
    `Errors in the last 24 h:\n${Object.entries(errCounts).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${v}x ${k}`).join('\n') || 'none'}`,
    `Referrals: ${ref || 'none yet'}`,
    `Recent events:\n${events.join('\n')}`,
  ].join('\n\n');
}

export async function ask(question) {
  const out = await llm([
    { role: 'system', content: `You are "S20", the owner's assistant inside his private chat app, running on his phone. You answer questions about
his job agent (and his phone) using ONLY the CONTEXT and HOW below. Be direct and short (2-6 sentences or a few bullets), use the actual
numbers and names from the context, and explain causes in plain words. If the context doesn't contain the answer, say exactly what is
missing and where he can look (hub pages: /jobs, /jobs/live, /jobs/errors, /jobs/referrals, /jobs/memory). Never invent jobs, numbers or errors.

HOW:
${HOW}` },
    { role: 'user', content: `CONTEXT:\n${context()}\n\nQUESTION: ${question}` },
  ], { maxTokens: 700, temperature: 0.2, why: 'answering your question in Cupboard' });
  return String(out || '').trim() || "I couldn't work that out from what I can see right now.";
}
