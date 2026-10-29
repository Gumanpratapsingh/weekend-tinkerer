// Job agent main process (Termux Node on the S20). Schedules discovery, scoring, applying and mail checks,
// and serves the WhatsApp webhook (public via nginx /wa/webhook) and /internal/resolve (browser worker only).
import { createServer } from 'node:http';
import { log, logError, every, istHour, config, activity, ROOT, HOME, PROFILE, DATA, PORT, OWNER, PERSON, resumeFile, hasSession, gate } from './core.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { browserTask } from './browser.mjs';
import { getKv, setKv, all } from './db.mjs';
import { discover, scoreNew } from './discover.mjs';
import { applyNext, todayStats } from './apply.mjs';
import { ncrOn, ncrEvery, ncrSweep, ncrNotify, ncrReferrals } from './ncr.mjs';
import { checkMail, mailConfigured } from './mail.mjs';
import { resolve, seedQuestions, seedKnown } from './answers.mjs';
import { askOwner, openQuestions } from './asks.mjs';
import { webhook, flush, tell, configured as waConfigured } from './whatsapp.mjs';
import { handleOwner, onAnswered } from './commands.mjs';
import { one, run } from './db.mjs';

import { watchdog } from './watchdog.mjs';
import { startCaptcha, captchaDone, liveCaptcha, expireStale } from './captcha.mjs';
import { needsSetup, startOnboarding, receiveFile, onboardReply, loginCommand, pendingStep, startSignin } from './onboard.mjs';

gate.open = !needsSetup();                          // a new person: only the chat + setup run until their profile exists
seedKnown();
run("UPDATE jobs SET status = 'queued' WHERE status = 'applying'");   // interrupted by a restart: try again
// Someone new (nothing applied yet) starts in review mode for two weeks: each application waits for their ✓ Submit
// (src/apply.mjs reviewJob). "review off" in their chat ends it early.
if (PERSON && getKv('review_until') == null && !one('SELECT 1 FROM jobs WHERE applied_at IS NOT NULL LIMIT 1')) setKv('review_until', Date.now() + 14 * 864e5);

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
        const { fields, context, job_id } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        // Fill-and-show (NCR chat): the answers shown in the screenshots are kept per job and reused when it is submitted.
        const memoKey = job_id && getKv(`fillans:${job_id}`) != null ? `fillans:${job_id}` : null;
        const memo = memoKey ? JSON.parse(getKv(memoKey, '{}')) : null;
        try {
          if (!memo) return reply(200, JSON.stringify(await resolve(fields, context)), 'application/json');
          const known = fields.filter((f) => memo[f.label] != null), rest = fields.filter((f) => memo[f.label] == null);
          const r = rest.length ? await resolve(rest, context) : { answers: {}, unknown: [] };
          for (const f of rest) if (r.answers[f.key] != null) memo[f.label] = r.answers[f.key];
          setKv(memoKey, JSON.stringify(memo));
          return reply(200, JSON.stringify({ ...r, answers: { ...r.answers, ...Object.fromEntries(known.map((f) => [f.key, memo[f.label]])) } }), 'application/json');
        }
        catch (e) { if (e.retryLater) return reply(503, '{"error":"AI busy"}', 'application/json'); throw e; }
      }
      if (url.pathname === '/internal/security-code' && !req.headers['x-visitor-ip']) {
        const { latestSecurityCode } = await import('./mail.mjs');
        return reply(200, JSON.stringify(await latestSecurityCode(url.searchParams.get('company') || '').catch(() => null) || {}), 'application/json');
      }
      if (url.pathname === '/internal/captcha-jobs' && !req.headers['x-visitor-ip']) {
        return reply(200, JSON.stringify(all("SELECT id, title, company, apply_url, apply_type, resume_path, score FROM jobs WHERE status = 'captcha' AND id != ? ORDER BY score DESC", liveCaptcha() || '')), 'application/json');
      }
      // Free-form question from the owner (Cupboard): answer from the agent's live state. Read-only.
      if (url.pathname === '/internal/ask' && req.method === 'POST' && !req.headers['x-visitor-ip']) {
        const b = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const { ask } = await import('./assistant.mjs');
        try { return reply(200, JSON.stringify({ answer: await ask(String(b.question || '').slice(0, 1000)) }), 'application/json'); }
        catch (e) { return reply(200, JSON.stringify({ answer: /rate limited/i.test(e.message) ? 'The free AI is busy right now (quota). Ask again in a few minutes, or check hub → Jobs.' : `Couldn't answer: ${e.message}` }), 'application/json'); }
      }
      // Answers and button taps from Cupboard (the owner's chat app on this phone, localhost only).
      if (url.pathname === '/internal/cupboard' && req.method === 'POST' && !req.headers['x-visitor-ip']) {
        const b = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (b.file) { receiveFile({ file: String(b.file), name: String(b.name || '') }).catch((e) => logError('onboard file', e)); return reply(200, '{"ok":true}', 'application/json'); }
        const ref = b.ref?.ref_kind ? { ref_kind: String(b.ref.ref_kind), ref_id: String(b.ref.ref_id) } : null;
        if (ref?.ref_kind === 'onboard') { onboardReply(ref.ref_id, String(b.text || '').slice(0, 2000), b.msgId); return reply(200, '{"ok":true}', 'application/json'); }
        await handleOwner(String(b.text || '').trim().slice(0, 2000), ref);
        // The owner answered through the copy of this person's question in the owner's chat: tell the person what was said for them.
        if (url.searchParams.get('by') === 'owner' && ref?.ref_kind === 'question') {
          const q = one('SELECT question FROM questions WHERE id = ?', Number(ref.ref_id));
          tell(`ℹ️ Guman answered "${String(q?.question || 'a question').slice(0, 120)}" for you: "${String(b.text || '').slice(0, 200)}". It will be used on your applications. If that's wrong, tell your job agent the right answer.`);
        }
        return reply(200, '{"ok":true}', 'application/json');
      }
      // Free text in the "📍 Delhi NCR jobs" chat: a job link to fill and show, or an answer. Replies go back to that chat.
      if (url.pathname === '/internal/ncr' && req.method === 'POST' && !req.headers['x-visitor-ip']) {
        const b = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const { ncrChat } = await import('./ncr.mjs');
        ncrChat(String(b.text || '').trim().slice(0, 2000)).catch((e) => logError('ncr chat', e));
        return reply(200, '{"ok":true}', 'application/json');
      }
      // A person's free text in their Cupboard bot chat (not the owner's): a setup answer or a question about their search.
      // Setup answers (they may carry a Gmail app password) are handled here and never go to the AI.
      if (url.pathname === '/internal/chat' && req.method === 'POST' && !req.headers['x-visitor-ip']) {
        const b = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const text = String(b.text || '').trim().slice(0, 2000);
        const json = (x) => reply(200, JSON.stringify(x), 'application/json');
        if (loginCommand(text)) return json({});
        const step = pendingStep();
        if (step) { onboardReply(step, text, b.msgId); return json({}); }
        if (/^ncr( referrals| aside)?( on| off)?$/i.test(text)) { await handleOwner(text.toLowerCase()); return json({}); }   // Gurgaon/Noida watch commands
        const { ask } = await import('./assistant.mjs');
        try { return json({ answer: await ask(text) }); }
        catch (e) { return json({ answer: /rate limited/i.test(e.message) ? 'The free AI is busy right now. Ask again in a few minutes.' : `Couldn't answer: ${e.message}` }); }
      }
      // Live sign-in page (Cupboard -> here -> browser worker): status, screen, taps/keys. Input bodies are never logged.
      if (url.pathname.startsWith('/internal/signin/') && !req.headers['x-visitor-ip']) {
        const site = url.searchParams.get('site') || JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}').site;
        if (!['linkedin', 'naukri', 'captcha'].includes(site)) return reply(400, '{"error":"bad site"}', 'application/json');
        const cjob = site === 'captcha' ? (url.searchParams.get('job') || JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}').job) : null;
        const json = (x, code = 200) => reply(code, JSON.stringify(x), 'application/json');
        const health = await fetch('http://127.0.0.1:8084/health', { signal: AbortSignal.timeout(5000) }).then((r) => r.json()).catch(() => ({}));
        const mine = health.signin === (PERSON || 'owner');
        const what = url.pathname.slice('/internal/signin/'.length);
        if (what === 'status') return json(site === 'captcha'
          ? { mine, busy: !!health.signin && !mine, signedIn: captchaDone(cjob) && !mine, title: one('SELECT title, company FROM jobs WHERE id = ?', String(cjob)) }
          : { mine, busy: !!health.signin && !mine, signedIn: !!getKv(`signin_done_${site}`) && !mine });
        if (what === 'start') { if (site === 'captcha') return json(await startCaptcha(cjob)); setKv(`signin_done_${site}`, ''); return json(await startSignin(site)); }
        if (what === 'frame') {
          const { writeFileSync, statSync } = await import('node:fs');
          writeFileSync(join(DATA, 'live-watch'), String(Date.now()));
          try { if (!mine || Date.now() - statSync(join(DATA, 'live-signin.jpg')).mtimeMs > 15e3) return reply(204, ''); } catch { return reply(204, ''); }
          res.writeHead(200, { 'Content-Type': 'image/jpeg' }); return res.end(readFileSync(join(DATA, 'live-signin.jpg')));
        }
        if (what === 'input' && req.method === 'POST') {
          if (!mine) return json({ error: 'The sign-in page is not open on the phone yet.' }, 409);
          const b = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const r = await fetch('http://127.0.0.1:8084/input', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10000),
            body: JSON.stringify({ kind: b.kind, x: b.x, y: b.y, text: b.text, key: b.key, _who: { person: PERSON || 'owner', port: PORT } }) }).catch(() => null);
          return json(r ? await r.json() : { error: 'phone browser not reachable' }, r?.status || 502);
        }
        return reply(404, 'not found');
      }
      // Is an urgent alert still needed? Cupboard asks before every reminder: once the job is applied, skipped, queued or closed, it stops.
      if (url.pathname === '/internal/urgent-open' && !req.headers['x-visitor-ip']) {
        const j = one('SELECT status FROM jobs WHERE id = ?', url.searchParams.get('job') || '');
        return reply(200, JSON.stringify({ open: !!j && ['manual', 'captcha', 'needs_answer', 'failed'].includes(j.status) }), 'application/json');
      }
      // The self-review for a day (default today), read-only: used by the morning fix-up session.
      if (url.pathname === '/internal/review' && req.method === 'GET' && !req.headers['x-visitor-ip']) {
        const { buildReview } = await import('./review.mjs');
        const day = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('day') || '') ? url.searchParams.get('day') : undefined;
        return reply(200, JSON.stringify(buildReview(day)), 'application/json');
      }
      // Dashboard data for this person's Cupboard app (Cupboard -> here; localhost only, read-only).
      if (url.pathname.startsWith('/internal/dash/') && req.method === 'GET' && !req.headers['x-visitor-ip']) {
        const dash = await import('./dash.mjs');
        const name = url.pathname.slice('/internal/dash/'.length), qs = Object.fromEntries(url.searchParams);
        if (name === 'screen') {
          const s = dash.screen();
          if (!s) return reply(204, '');
          res.writeHead(200, { 'Content-Type': 'image/jpeg', 'X-Task': encodeURIComponent(s.meta.task || ''), 'X-Url': encodeURIComponent(String(s.meta.url || '').slice(0, 200)) });
          return res.end(s.image);
        }
        const fn = { summary: dash.summary, list: dash.list, detail: dash.detail, memory: dash.memory, referrals: dash.referrals, log: dash.log }[name];
        if (!fn) return reply(404, '{"error":"not found"}', 'application/json');
        const out = fn(qs);
        return out ? reply(200, JSON.stringify(out), 'application/json') : reply(404, '{"error":"Not found."}', 'application/json');
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
          case 'queue': run("UPDATE jobs SET status = 'queued', attempts = 0, status_note = 'queued by you' WHERE id = ? AND status NOT IN ('applied','interview')", String(b.id)); setKv(`ncrapply:${String(b.id)}`, '1'); return ok();   // ncrapply: the NCR sweep leaves it alone
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
          case 'ref_decide': { const { decide } = await import('./referrals.mjs'); return ok({ message: decide(Number(b.id), String(b.answer || 'ok')) }); }
          case 'ref_find': {                                  // owner: "get referrals for this job" (runs in the background)
            const { prospect } = await import('./referrals.mjs');
            prospect({ only: String(b.company), jobId: b.id ? String(b.id) : null }).catch((e) => logError('referrals find', e, { company: b.company }));
            return ok({ message: `Looking for people at ${b.company}; drafts will come for your approval.` });
          }
          case 'ref_companies': {                             // owner edits the target list on the hub
            const c = JSON.parse(readFileSync(join(PROFILE, 'config.json'), 'utf8'));
            c.referrals = { ...(c.referrals || {}), companies: String(b.answer || '').split(/[\n,]+/).map((x) => x.trim()).filter(Boolean).slice(0, 200) };
            const { writeFileSync } = await import('node:fs');
            writeFileSync(join(PROFILE, 'config.json'), JSON.stringify(c, null, 2));
            return ok({ companies: c.referrals.companies.length });
          }
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
  if (h < from || h >= to || !(hasSession('naukri') || hasSession('linkedin'))) return;
  await step('Fast lane: checking Naukri + LinkedIn for jobs posted in the last hour', async () => {
    const added = await discover('fresh');
    if (added) { activity(`⚡ Fast lane: ${added} fresh job(s) — scoring now, they go first`); await scoreNew(40); }
  })();
}, { delay: 600e3 });

// Gurgaon/Noida watch (src/ncr.mjs): NCR-only searches every half hour in the daytime, scored first; good matches go to the
// person's chat as links and are never applied automatically. The link sender also catches NCR jobs from every other source.
every(ncrEvery(), 'ncr watch', async () => {             // all night too: Naukri (your account) only 05:00-23:00, see fetchNcr
  if (!ncrOn()) return;
  await step('Gurgaon/Noida watch: MNC career sites, LinkedIn (Gurugram area) and Naukri (Delhi NCR)', async () => {
    const added = await discover('ncr');
    if (added) { activity(`📍 Gurgaon/Noida watch: ${added} new job(s) — scoring now`); await scoreNew(40); }
    await ncrNotify();
  })();
}, { delay: 90e3 });
every(5, 'ncr links', async () => { ncrSweep(); await ncrNotify(); }, { delay: 100e3 });
every(10, 'ncr referrals', () => ncrReferrals(), { delay: 5 * 60e3 });   // auto-connect: plain requests to referrers at NCR companies (one job an hour at most; the gate is inside)

// Naukri profile refresh: 09:05 (base resume + next headline -> "updated today") and 22:45 (restore base resume).
every(5, 'naukri refresh', async () => {
  if (!hasSession('naukri')) return;
  const n = new Date(Date.now() + 5.5 * 3600e3), hm = n.getUTCHours() * 60 + n.getUTCMinutes(), day = n.toISOString().slice(0, 10);
  for (const [slot, at, rotate] of [['am', 9 * 60 + 5, true], ['pm', 22 * 60 + 45, false]]) {
    if (hm < at || hm > at + 60 || getKv(`naukri_refresh_${slot}`) === day) continue;
    setKv(`naukri_refresh_${slot}`, day);
    const heads = config().naukri_headlines || [];
    const i = Number(getKv('naukri_headline_i', 0));
    const r = await browserTask('naukri_refresh', { resume: resumeFile() /* owner's original file and name */, headline: rotate && heads.length ? heads[i % heads.length] : null }, 5 * 60e3)
      .catch((e) => ({ status: 'error', reason: e.message }));
    if (rotate) setKv('naukri_headline_i', i + 1);
    log(`naukri refresh ${slot}: ${r.status}${r.reason ? ' ' + r.reason : ''}`);
  }
});

every(180, 'discover aggregators', step('Searching Adzuna and Jooble (all of India)', () => discover('aggregators')), { delay: 270e3 });
every(360, 'discover remotive', step('Searching Remotive', () => discover('remotive')), { delay: 240e3 });
every(10, 'score', step('Scoring new jobs against your resume', () => scoreNew(25)), { delay: 60e3 });
every(60, 'watchdog', () => watchdog(), { delay: 10 * 60e3 });           // repeated failures -> one urgent alert; button-label answers deleted
every(60, 'stale jobs', () => expireStale(), { delay: 3 * 60e3 });     // CAPTCHA / answer waits that are too old to still be open
every(1, 'apply', () => applyNext({ dryRun: getKv('dry_run', '1') === '1' }), { delay: 120e3 });   // pacing lives in apply.mjs
// Security / verification codes: checked every minute (no AI), forwarded to Cupboard once each, so a form can be finished on mobile.
every(1, 'security codes', async () => {
  const { forwardSecurityCodes } = await import('./mail.mjs');
  await forwardSecurityCodes(tell);
}, { delay: 45e3 });

// Inbox: every mail_check_hours (owner's choice: 8 h). Checked on a 15-minute tick; survives restarts via kv.
every(15, 'mail', async () => {
  if (!mailConfigured()) return;
  const due = Number(getKv('mail_last_check', 0)) + (config().mail_check_hours || 8) * 3600e3;
  if (Date.now() < due) return;
  setKv('mail_last_check', Date.now());
  await step('Checking your inbox', checkMail)();
}, { delay: 30e3 });
every(5, 'whatsapp', () => flush(), { delay: 45e3 });
every(60, 'first-time setup', async () => startOnboarding(), { delay: 8e3, always: true });
// Safety net: a job waiting on answers that are all in (answered elsewhere, or its questions dismissed) goes back to the queue.
every(10, 'unstick answered jobs', async () => {
  const stuck = all(`SELECT id FROM jobs WHERE status = 'needs_answer'
    AND NOT EXISTS (SELECT 1 FROM asks a WHERE a.job_id = jobs.id AND a.status = 'open')`);
  for (const j of stuck) run("UPDATE jobs SET status = 'queued', attempts = 0, status_note = 'answers received' WHERE id = ?", j.id);
  if (stuck.length) activity(`↩️ ${stuck.length} job(s) had all their answers: back in the queue`);
}, { delay: 60e3 });

// Setup questions, asked once when WhatsApp is first connected.
every(30, 'setup', async () => {
  if (getKv('setup_asked') || (OWNER ? !waConfigured() : needsSetup())) return;   // others: right after their Cupboard setup
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

// Nightly self-review (21:00 IST): what needed a human today, grouped into patterns, saved for the morning fix-up session.
every(10, 'nightly review', async () => {
  const n = new Date(Date.now() + 5.5 * 3600e3), day = n.toISOString().slice(0, 10);
  if (n.getUTCHours() !== 21 || getKv('review_day') === day) return;
  setKv('review_day', day);
  const { nightlyReview } = await import('./review.mjs');
  nightlyReview();
}, { always: true });

// Nightly housekeeping (03:30 IST): rotate logs over 5 MB, delete screenshots older than 30 days.
every(30, 'housekeeping', async () => {
  const n = new Date(Date.now() + 5.5 * 3600e3), day = n.toISOString().slice(0, 10);
  if (n.getUTCHours() !== 3 || getKv('housekeeping_day') === day) return;
  setKv('housekeeping_day', day);
  const { statSync, renameSync, readdirSync, unlinkSync } = await import('node:fs');
  for (const f of ['activity.log', 'agent.log', 'worker.log', 'errors.jsonl']) {
    const p = join(DATA, f);
    try { if (statSync(p).size > 5e6) { for (let i = 6; i >= 1; i--) { try { renameSync(`${p}.${i}`, `${p}.${i + 1}`); } catch {} } renameSync(p, `${p}.1`); } } catch { /* missing */ }
  }
  let removed = 0;
  for (const f of readdirSync(join(DATA, 'shots'))) {
    const p = join(DATA, 'shots', f);
    try { if (Date.now() - statSync(p).mtimeMs > 30 * 864e5) { unlinkSync(p); removed++; } } catch { /* raced */ }
  }
  log(`housekeeping: logs rotated if over 5 MB, ${removed} old screenshot(s) removed`);
});

// Referral outreach: find people + queue drafts hourly (daytime), send approved ones in spaced slots, check acceptances daily.
every(60, 'referral prospecting', async () => {
  const h = istHour(); if (h < 9 || h >= 21 || getKv('thermal_pause') === '1' || !hasSession('linkedin')) return;
  const { prospect } = await import('./referrals.mjs'); await prospect();
}, { delay: 15 * 60e3 });
every(240, 'referral posts', async () => {                 // LinkedIn posts offering referrals, every 4 h in the daytime
  const h = istHour(); if (h < 9 || h >= 21 || getKv('thermal_pause') === '1' || !hasSession('linkedin')) return;
  const { scanPosts } = await import('./referrals.mjs'); await scanPosts();
}, { delay: 25 * 60e3 });
every(5, 'referral sending', async () => {
  if (getKv('thermal_pause') === '1' || !hasSession('linkedin')) return;
  const { send } = await import('./referrals.mjs'); await send();
}, { delay: 4 * 60e3 });
every(60, 'referral acceptances', async () => {
  const n = new Date(Date.now() + 5.5 * 3600e3), day = n.toISOString().slice(0, 10);
  if (n.getUTCHours() < 10 || getKv('ref_check_day') === day) return;
  if (!hasSession('linkedin')) return;
  setKv('ref_check_day', day);
  const { checkAccepted } = await import('./referrals.mjs'); await checkAccepted();
}, { delay: 20 * 60e3 });
every(60, 'referral draft cleanup', async () => {               // drafts the owner never acted on: drop after 5 days
  const n = new Date(Date.now() + 5.5 * 3600e3), day = n.toISOString().slice(0, 10);
  if (n.getUTCHours() < 10 || getKv('ref_prune_day') === day) return;
  setKv('ref_prune_day', day);
  const { pruneOldDrafts } = await import('./referrals.mjs'); pruneOldDrafts();
}, { delay: 22 * 60e3 });

// Thermal guard: the phone runs 24/7 on a charger. Too hot -> pause all browser work and close Chromium; resume when cool.
every(1, 'thermal guard', async () => {
  const st = (() => { try { return JSON.parse(readFileSync(join(HOME, 'live', 'status.json'), 'utf8')); } catch { return null; } })();
  if (!st) return;
  // Limits per device: the phone's (config.thermal) kept the laptop paused forever. The laptop has no battery sensor
  // (both fields hold the CPU temperature), so there only the CPU counts: 90 °C pause, 80 °C resume (config.thermal_laptop).
  // laptop/ has its own last-resort guard at 95 °C that stops the units.
  const t = /laptop/i.test(st.device || '')
    ? { pause_cpu_c: 90, resume_cpu_c: 80, pause_battery_c: Infinity, resume_battery_c: Infinity, ...(config().thermal_laptop || {}) }
    : (config().thermal || {});
  const paused = getKv('thermal_pause') === '1';
  if (!paused && (st.batteryTempC >= t.pause_battery_c || st.cpuTempC >= t.pause_cpu_c)) {
    setKv('thermal_pause', '1');
    activity(`🌡️ ${/laptop/i.test(st.device || '') ? 'Laptop' : 'Phone'} is hot (battery ${st.batteryTempC}°C, CPU ${st.cpuTempC}°C): pausing the browser to cool down`);
    await browserTask('rest', {}, 60e3).catch(() => {});
  } else if (paused && st.batteryTempC <= t.resume_battery_c && st.cpuTempC <= t.resume_cpu_c) {
    setKv('thermal_pause', '0');
    activity(`🌡️ Cooled down (battery ${st.batteryTempC}°C, CPU ${st.cpuTempC}°C): resuming`);
  }
}, { delay: 30e3, always: true });

// Watchdog: the browser worker answers /health instantly; two misses in a row -> restart it.
let workerMisses = 0;
if (OWNER) every(2, 'worker watchdog', async () => {     // the shared worker is the owner agent's to restart
  const ok = await fetch('http://127.0.0.1:8084/health', { signal: AbortSignal.timeout(15000) }).then((r) => r.ok).catch(() => false);
  workerMisses = ok ? 0 : workerMisses + 1;
  if (workerMisses < 2) return;
  workerMisses = 0;
  activity('🔧 Phone browser was down: restarting it');
  const { spawn } = await import('node:child_process');
  spawn('sh', [join(ROOT, 'scripts', 'run.sh'), 'worker'], { detached: true, stdio: 'ignore' }).unref();
}, { delay: 90e3 });

process.on('unhandledRejection', (e) => logError('unhandled', e));
process.on('uncaughtException', (e) => logError('uncaught', e));   // recorded, and the agent keeps running

// Error alerts: a brand-new kind of error, or a spike (20+ in an hour) -> one message to the owner.
every(30, 'error alerts', async () => {
  const { readFileSync } = await import('node:fs');
  let rows = [];
  try { rows = readFileSync(join(DATA, 'errors.jsonl'), 'utf8').trim().split('\n').slice(-3000).map((l) => JSON.parse(l)); } catch { return; }
  const sig = (r) => `${r.kind}: ${String(r.message).replace(/\d{3,}/g, 'N').replace(/https?:\/\/\S+/g, 'URL').slice(0, 80)}`;
  const known = new Set(JSON.parse(getKv('error_sigs', '[]')));
  const hour = rows.filter((r) => Date.now() - Date.parse(r.at) < 3600e3);
  const fresh = [...new Set(hour.map(sig))].filter((x) => !known.has(x));
  if (fresh.length) {
    tell(`🐞 New kind of error in the job agent${OWNER ? '' : ` (${PERSON})`}:\n${fresh.slice(0, 3).map((x) => `• ${x}`).join('\n')}\nDetails: hub → Jobs → Errors.`, { toOwner: true });
    setKv('error_sigs', JSON.stringify([...known, ...fresh].slice(-300)));
  }
  if (hour.length >= 20 && getKv('error_spike_hour') !== new Date().toISOString().slice(0, 13)) {
    setKv('error_spike_hour', new Date().toISOString().slice(0, 13));
    tell(`🐞 ${hour.length} errors in the last hour in the job agent${OWNER ? '' : ` (${PERSON})`}. Details: hub → Jobs → Errors.`, { toOwner: true });
  }
}, { delay: 120e3, always: true });
