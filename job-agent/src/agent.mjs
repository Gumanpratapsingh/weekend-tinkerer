// Job agent main process (Termux Node on the S20). Schedules discovery, scoring, applying and mail checks,
// and serves the WhatsApp webhook (public via nginx /wa/webhook) and /internal/resolve (browser worker only).
import { createServer } from 'node:http';
import { log, every, istHour, config } from './core.mjs';
import { getKv, setKv, all } from './db.mjs';
import { discover, scoreNew } from './discover.mjs';
import { applyNext, todayStats } from './apply.mjs';
import { checkMail, mailConfigured } from './mail.mjs';
import { resolve, seedQuestions, seedKnown } from './answers.mjs';
import { askOwner, openQuestions } from './asks.mjs';
import { webhook, flush, tell, configured as waConfigured } from './whatsapp.mjs';
import { handleOwner, onAnswered } from './commands.mjs';
import { one, run } from './db.mjs';

const PORT = 8083;
seedKnown();

createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => { chunks.push(c); if (chunks.length > 200) req.destroy(); });
  req.on('end', async () => {
    const url = new URL(req.url, 'http://x');
    const reply = (status, body, type = 'text/plain') => { res.writeHead(status, { 'Content-Type': type }); res.end(body); };
    try {
      if (url.pathname === '/wa/webhook') {
        const r = await webhook(req.method, Object.fromEntries(url.searchParams), Buffer.concat(chunks).toString('utf8'), req.headers, handleOwner);
        return reply(r.status, r.body);
      }
      // Only the browser worker on this phone may call /internal (nginx never proxies it; tunnel traffic carries X-Visitor-IP).
      if (url.pathname === '/internal/resolve' && req.method === 'POST' && !req.headers['x-visitor-ip']) {
        const { fields, context } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        return reply(200, JSON.stringify(await resolve(fields, context)), 'application/json');
      }
      if (url.pathname === '/internal/captcha-jobs' && !req.headers['x-visitor-ip']) {
        return reply(200, JSON.stringify(all("SELECT id, title, company, apply_url, apply_type, resume_path, score FROM jobs WHERE status = 'captcha' ORDER BY score DESC")), 'application/json');
      }
      // Dashboard actions from the tinker hub server (same phone, localhost only, owner already logged in there).
      if (url.pathname === '/internal/action' && req.method === 'POST' && !req.headers['x-visitor-ip']) {
        const b = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const ok = (x = {}) => reply(200, JSON.stringify({ ok: true, ...x }), 'application/json');
        switch (b.action) {
          case 'answer': await onAnswered(Number(b.id), String(b.answer || '').slice(0, 2000)); return ok();
          case 'pause': setKv('paused', '1'); return ok();
          case 'resume': setKv('paused', '0'); return ok();
          case 'live': setKv('dry_run', '0'); run("UPDATE jobs SET status = 'queued' WHERE status = 'ready'"); return ok();
          case 'dry': setKv('dry_run', '1'); return ok();
          case 'skip': run("UPDATE jobs SET status = 'skipped', status_note = 'skipped by you' WHERE id = ?", String(b.id)); return ok();
          case 'queue': run("UPDATE jobs SET status = 'queued', attempts = 0, status_note = 'queued by you' WHERE id = ? AND status NOT IN ('applied','interview')", String(b.id)); return ok();
          case 'applied': run("UPDATE jobs SET status = 'applied', applied_at = ?, status_note = 'applied by you' WHERE id = ?", Date.now(), String(b.id)); return ok();
          case 'forget': run('UPDATE questions SET answer = NULL WHERE id = ?', Number(b.id)); return ok();
        }
        return reply(400, '{"error":"unknown action"}', 'application/json');
      }
      reply(404, 'not found');
    } catch (e) { log(`http ${url.pathname}: ${e.stack || e.message}`); reply(500, 'error'); }
  });
}).listen(PORT, '127.0.0.1', () => log(`job agent on 127.0.0.1:${PORT}`));

// ---------- schedules ----------
const doing = (text) => setKv('now', JSON.stringify({ text, at: Date.now() }));
const step = (text, fn) => async () => { doing(text); try { return await fn(); } finally { doing('Idle — waiting for the next run'); } };

every(150, 'discover ats', step('Searching company career pages (Greenhouse, Lever, Ashby)', () => discover('ats')), { delay: 20e3 });
every(180, 'discover linkedin', step('Searching LinkedIn', () => discover('linkedin')), { delay: 90e3 });
every(180, 'discover naukri', step('Searching Naukri', () => discover('naukri')), { delay: 150e3 });
every(240, 'discover feeds', step('Searching remote job feeds (Himalayas, Jobicy, WWR)', () => discover('feeds')), { delay: 200e3 });
every(360, 'discover remotive', step('Searching Remotive', () => discover('remotive')), { delay: 240e3 });
every(10, 'score', step('Scoring new jobs against your resume', () => scoreNew(25)), { delay: 60e3 });
every(1, 'apply', () => applyNext({ dryRun: getKv('dry_run', '1') === '1' }), { delay: 120e3 });   // pacing lives in apply.mjs
every(5, 'mail', async () => { if (mailConfigured()) await step('Checking your inbox', checkMail)(); }, { delay: 30e3 });
every(5, 'whatsapp', () => flush(), { delay: 45e3 });

// Setup questions, asked once when WhatsApp is first connected.
every(30, 'setup', async () => {
  if (!waConfigured() || getKv('setup_asked')) return;
  setKv('setup_asked', Date.now());
  tell('👋 Job agent is live. I find jobs (Naukri, LinkedIn, company career pages), tailor your resume to each, apply when the fit is ≥ '
    + `${config().min_score}%, watch ${config().mailbox} for replies, and ask you here when I meet a question I can't answer. `
    + 'First, a few basics every application asks:');
  for (const q of seedQuestions()) askOwner(q.question, { context: 'setup' });
  run("UPDATE outbox SET urgent = 1 WHERE sent_at IS NULL");      // first-run setup goes out even in quiet hours
}, { delay: 10e3 });

// Evening digest at ~21:30 IST.
every(10, 'digest', async () => {
  const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  const now = new Date(Date.now() + 5.5 * 3600e3);
  if (now.getUTCHours() !== 21 || now.getUTCMinutes() < 30 || getKv('digest_day') === today) return;
  setKv('digest_day', today);
  const s = todayStats();
  const applied = all("SELECT title, company, score FROM jobs WHERE status = 'applied' AND applied_at >= ? ORDER BY applied_at", Date.parse(`${today}T00:00:00+05:30`));
  const ev = all("SELECT kind, text FROM events WHERE at >= ? AND kind IN ('interview','assessment','offer','rejection')", Date.parse(`${today}T00:00:00+05:30`));
  tell(`🌙 Daily report\nApplied today: ${s.applied}${applied.length ? '\n' + applied.map((a) => `• ${a.title} @ ${a.company} (${a.score}%)`).join('\n') : ''}`
    + `${ev.length ? `\n\nReplies:\n${ev.map((e) => `• ${e.kind}: ${e.text}`).join('\n')}` : ''}`
    + `\n\nQueue ${s.queued} · apply-yourself ${s.manual} (send "manual") · open questions ${openQuestions().length}`
    + `\nAll time: ${s.appliedTotal} applied, ${s.interviews} interview stage.`);
});

process.on('unhandledRejection', (e) => log(`unhandled: ${e?.stack || e}`));
