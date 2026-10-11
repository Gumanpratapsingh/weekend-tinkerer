// Job agent main process (Termux Node on the S20). Schedules discovery, scoring, applying and mail checks,
// and serves the WhatsApp webhook (public via nginx /wa/webhook) and /internal/resolve (browser worker only).
import { createServer } from 'node:http';
import { log, every, istHour, config, activity, ROOT, HOME } from './core.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { browserTask } from './browser.mjs';
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
run("UPDATE jobs SET status = 'queued' WHERE status = 'applying'");   // interrupted by a restart: try again

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
        try { return reply(200, JSON.stringify(await resolve(fields, context)), 'application/json'); }
        catch (e) { if (e.retryLater) return reply(503, '{"error":"AI busy"}', 'application/json'); throw e; }
      }
      if (url.pathname === '/internal/captcha-jobs' && !req.headers['x-visitor-ip']) {
        return reply(200, JSON.stringify(all("SELECT id, title, company, apply_url, apply_type, resume_path, score FROM jobs WHERE status = 'captcha' ORDER BY score DESC")), 'application/json');
      }
      // Answers and button taps from Cupboard (the owner's chat app on this phone, localhost only).
      if (url.pathname === '/internal/cupboard' && req.method === 'POST' && !req.headers['x-visitor-ip']) {
        const b = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const ref = b.ref?.ref_kind ? { ref_kind: String(b.ref.ref_kind), ref_id: String(b.ref.ref_id) } : null;
        await handleOwner(String(b.text || '').trim().slice(0, 2000), ref);
        return reply(200, '{"ok":true}', 'application/json');
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
          // Owner is applying by hand: park the job where neither the apply loop nor a bulk requeue of 'manual' jobs touches it.
          case 'claim': {
            const j = one('SELECT status FROM jobs WHERE id = ?', String(b.id));
            if (!j) return ok({ ok: false, error: 'No such job.' });
            if (j.status === 'applying') return ok({ ok: false, error: 'The agent is applying to this job right now. Try again in a minute.' });
            if (['applied', 'interview'].includes(j.status)) return ok({ ok: false, error: `Already ${j.status}.` });
            run("UPDATE jobs SET status = 'claimed', status_note = 'you are applying by hand' WHERE id = ?", String(b.id));
            return ok();
          }
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
const doing = (text) => { setKv('now', JSON.stringify({ text, at: Date.now() })); if (!/^Idle/.test(text)) activity(`▶ ${text}`); };
const step = (text, fn) => async () => { doing(text); try { return await fn(); } finally { doing('Idle — waiting for the next run'); } };

every(150, 'discover ats', step('Searching company career pages (Greenhouse, Lever, Ashby)', () => discover('ats')), { delay: 20e3 });
every(180, 'discover linkedin', step('Searching LinkedIn', () => discover('linkedin')), { delay: 90e3 });
every(180, 'discover naukri', step('Searching Naukri', () => discover('naukri')), { delay: 150e3 });
every(240, 'discover feeds', step('Searching remote job feeds (Himalayas, Jobicy)', () => discover('feeds')), { delay: 200e3 });
// Fast lane: jobs posted in the last hour or so go straight to scoring and the front of the queue.
every(config().fresh_lane?.every_min || 40, 'fresh lane', async () => {
  const [from, to] = config().fresh_lane?.hours || [8, 23];
  const h = istHour();
  if (h < from || h >= to) return;
  await step('Fast lane: checking Naukri + LinkedIn for jobs posted in the last hour', async () => {
    const added = await discover('fresh');
    if (added) { activity(`⚡ Fast lane: ${added} fresh job(s) — scoring now, they go first`); await scoreNew(40); }
  })();
}, { delay: 600e3 });

// Naukri profile refresh: 09:05 (base resume + next headline -> "updated today") and 22:45 (restore base resume).
every(5, 'naukri refresh', async () => {
  const n = new Date(Date.now() + 5.5 * 3600e3), hm = n.getUTCHours() * 60 + n.getUTCMinutes(), day = n.toISOString().slice(0, 10);
  for (const [slot, at, rotate] of [['am', 9 * 60 + 5, true], ['pm', 22 * 60 + 45, false]]) {
    if (hm < at || hm > at + 60 || getKv(`naukri_refresh_${slot}`) === day) continue;
    setKv(`naukri_refresh_${slot}`, day);
    const heads = config().naukri_headlines || [];
    const i = Number(getKv('naukri_headline_i', 0));
    const r = await browserTask('naukri_refresh', { resume: join(ROOT, 'profile', config().naukri_resume || 'GPS_RESUME_SPRINGBOOT_DEVELOPER.pdf') /* owner's original file and name */, headline: rotate && heads.length ? heads[i % heads.length] : null }, 5 * 60e3)
      .catch((e) => ({ status: 'error', reason: e.message }));
    if (rotate) setKv('naukri_headline_i', i + 1);
    log(`naukri refresh ${slot}: ${r.status}${r.reason ? ' ' + r.reason : ''}`);
  }
});

every(180, 'discover aggregators', step('Searching Adzuna and Jooble (all of India)', () => discover('aggregators')), { delay: 270e3 });
every(360, 'discover remotive', step('Searching Remotive', () => discover('remotive')), { delay: 240e3 });
every(10, 'score', step('Scoring new jobs against your resume', () => scoreNew(25)), { delay: 60e3 });
every(1, 'apply', () => applyNext({ dryRun: getKv('dry_run', '1') === '1' }), { delay: 120e3 });   // pacing lives in apply.mjs
// Inbox: every mail_check_hours (owner's choice: 8 h). Checked on a 15-minute tick; survives restarts via kv.
every(15, 'mail', async () => {
  if (!mailConfigured()) return;
  const due = Number(getKv('mail_last_check', 0)) + (config().mail_check_hours || 8) * 3600e3;
  if (Date.now() < due) return;
  setKv('mail_last_check', Date.now());
  await step('Checking your inbox', checkMail)();
}, { delay: 30e3 });
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

// Nightly housekeeping (03:30 IST): rotate logs over 5 MB, delete screenshots older than 30 days.
every(30, 'housekeeping', async () => {
  const n = new Date(Date.now() + 5.5 * 3600e3), day = n.toISOString().slice(0, 10);
  if (n.getUTCHours() !== 3 || getKv('housekeeping_day') === day) return;
  setKv('housekeeping_day', day);
  const { statSync, renameSync, readdirSync, unlinkSync } = await import('node:fs');
  for (const f of ['activity.log', 'agent.log', 'worker.log']) {
    const p = join(ROOT, 'data', f);
    try { if (statSync(p).size > 5e6) renameSync(p, `${p}.1`); } catch { /* missing */ }
  }
  let removed = 0;
  for (const f of readdirSync(join(ROOT, 'data', 'shots'))) {
    const p = join(ROOT, 'data', 'shots', f);
    try { if (Date.now() - statSync(p).mtimeMs > 30 * 864e5) { unlinkSync(p); removed++; } } catch { /* raced */ }
  }
  log(`housekeeping: logs rotated if over 5 MB, ${removed} old screenshot(s) removed`);
});

// Thermal guard: the phone runs 24/7 on a charger. Too hot -> pause all browser work and close Chromium; resume when cool.
every(1, 'thermal guard', async () => {
  const st = (() => { try { return JSON.parse(readFileSync(join(HOME, 'live', 'status.json'), 'utf8')); } catch { return null; } })();
  if (!st) return;
  const t = config().thermal || {};
  const paused = getKv('thermal_pause') === '1';
  if (!paused && (st.batteryTempC >= t.pause_battery_c || st.cpuTempC >= t.pause_cpu_c)) {
    setKv('thermal_pause', '1');
    activity(`🌡️ Phone is hot (battery ${st.batteryTempC}°C, CPU ${st.cpuTempC}°C): pausing the browser to cool down`);
    await browserTask('rest', {}, 60e3).catch(() => {});
  } else if (paused && st.batteryTempC <= t.resume_battery_c && st.cpuTempC <= t.resume_cpu_c) {
    setKv('thermal_pause', '0');
    activity(`🌡️ Cooled down (battery ${st.batteryTempC}°C, CPU ${st.cpuTempC}°C): resuming`);
  }
}, { delay: 30e3 });

// Watchdog: the browser worker answers /health instantly; two misses in a row -> restart it.
let workerMisses = 0;
every(2, 'worker watchdog', async () => {
  const ok = await fetch('http://127.0.0.1:8084/health', { signal: AbortSignal.timeout(15000) }).then((r) => r.ok).catch(() => false);
  workerMisses = ok ? 0 : workerMisses + 1;
  if (workerMisses < 2) return;
  workerMisses = 0;
  activity('🔧 Phone browser was down: restarting it');
  const { spawn } = await import('node:child_process');
  spawn('sh', [join(ROOT, 'scripts', 'run.sh'), 'worker'], { detached: true, stdio: 'ignore' }).unref();
}, { delay: 90e3 });

process.on('unhandledRejection', (e) => log(`unhandled: ${e?.stack || e}`));
