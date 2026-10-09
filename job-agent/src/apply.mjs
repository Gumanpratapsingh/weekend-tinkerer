// Apply queue: takes queued jobs (score >= min_score), tailors the resume, and applies through the browser worker,
// within daily caps per site. Unknown required questions park the job as needs_answer and ask the owner.
import { config, log, istDate, istHour } from './core.mjs';
import { one, all, run, event, getKv, setKv } from './db.mjs';
import { tailor } from './tailor.mjs';
import { browserTask } from './browser.mjs';
import { askOwner } from './asks.mjs';
import { tell } from './whatsapp.mjs';

const BUCKET = { naukri: 'naukri', linkedin: 'linkedin', greenhouse: 'ats', lever: 'ats', ashby: 'ats', external: 'ats' };
const sessionReady = { naukri: () => getKv('session_naukri') !== 'expired', linkedin: () => getKv('session_linkedin') !== 'expired' };

function appliedToday(bucket) {
  const since = Date.parse(`${istDate()}T00:00:00+05:30`);
  const rows = all("SELECT apply_type FROM jobs WHERE status = 'applied' AND applied_at >= ?", since);
  return bucket ? rows.filter((r) => BUCKET[r.apply_type] === bucket).length : rows.length;
}

// Anti-spam pacing per site: allowed hours (IST), a random gap since the last attempt on that site,
// daily caps per site and per company. One application at a time across the whole phone.
function siteReady(bucket) {
  const p = config().pacing[bucket];
  const h = istHour();
  if (h < p.hours[0] || h >= p.hours[1]) return false;
  const last = Number(getKv(`last_${bucket}`, 0));
  const gap = Number(getKv(`gap_${bucket}`, 0)) || p.min_gap_min * 60e3;
  return Date.now() - last >= gap;
}
function noteAttempt(bucket) {
  const p = config().pacing[bucket];
  setKv(`last_${bucket}`, Date.now());
  setKv(`gap_${bucket}`, Math.round((p.min_gap_min + Math.random() * (p.max_gap_min - p.min_gap_min)) * 60e3));
}
function companyToday(company) {
  const since = Date.parse(`${istDate()}T00:00:00+05:30`);
  return one("SELECT count(*) n FROM jobs WHERE company = ? AND applied_at >= ?", company, since).n;
}

export async function applyNext({ dryRun = false } = {}) {
  if (getKv('paused') === '1') return null;
  const caps = config().daily_caps;
  if (!dryRun && appliedToday() >= caps.total) return null;
  const queued = all("SELECT * FROM jobs WHERE status = 'queued' ORDER BY score DESC, found_at LIMIT 200");
  const job = queued.find((j) => {
    const b = BUCKET[j.apply_type];
    return b && siteReady(b) && (dryRun || appliedToday(b) < caps[b]) && companyToday(j.company) < caps.per_company
      && (sessionReady[j.apply_type]?.() ?? true) && (j.attempts || 0) < 3;
  });
  if (!job) return null;
  noteAttempt(BUCKET[job.apply_type]);
  return applyJob(job, { dryRun });
}

export async function applyJob(job, { dryRun = false } = {}) {
  run("UPDATE jobs SET status = 'applying', attempts = attempts + 1 WHERE id = ?", job.id);
  setKv('now', JSON.stringify({ text: `${dryRun ? 'Dry run: filling' : 'Applying to'} ${job.title} @ ${job.company} (${job.source}, ${job.score}%)`, at: Date.now(), job: job.id }));
  try {
    let resume = job.resume_path;
    if (!resume) {
      const t = await tailor(job);
      resume = t.pdf;
      run('UPDATE jobs SET resume_path = ?, track = ? WHERE id = ?', resume, t.track, job.id);
    }
    const res = await browserTask(`apply_${job.apply_type}`, { job, resume, dryRun }, 10 * 60e3);
    log(`apply ${job.id}: ${JSON.stringify({ ...res, unknown: res.unknown?.length })}`);
    return settle(job, res);
  } catch (e) {
    log(`apply ${job.id} error: ${e.message}`);
    if (e.rateLimited) { run("UPDATE jobs SET status = 'queued', attempts = attempts - 1 WHERE id = ?", job.id); return { status: 'later' }; }
    run("UPDATE jobs SET status = ?, status_note = ? WHERE id = ?", (job.attempts || 0) + 1 >= 3 ? 'failed' : 'queued', e.message.slice(0, 300), job.id);
    return { status: 'error', reason: e.message };
  }
}

function settle(job, res) {
  const label = `${job.title} @ ${job.company}`;
  switch (res.status) {
    case 'applied':
      run("UPDATE jobs SET status = 'applied', applied_at = ?, status_note = ? WHERE id = ?", Date.now(), res.shot || null, job.id);
      event('applied', `${label} (${job.score}%, ${job.source})`);
      break;
    case 'needs_answer':
      run("UPDATE jobs SET status = 'needs_answer', status_note = ? WHERE id = ?", `${res.unknown.length} question(s) for you`, job.id);
      for (const u of res.unknown) askOwner(u.label, { jobId: job.id, context: `${label} application`, kind: u.type, options: u.options?.length ? u.options : null });
      run('UPDATE jobs SET attempts = 0 WHERE id = ?', job.id);
      break;
    case 'manual':
      // Naukri/LinkedIn jobs that apply on the company's own site: hand them to the generic external applier.
      if (/company site/.test(res.reason || '') && job.apply_type !== 'external') {
        run("UPDATE jobs SET apply_type = 'external', status = 'queued', attempts = 0, status_note = 'applies on company site' WHERE id = ?", job.id);
        break;
      }
      // CAPTCHA: the Mac helper (scripts/finish.sh) opens it prefilled for the owner to solve and submit.
      if (/captcha/i.test(res.reason || '')) {
        run("UPDATE jobs SET status = 'captcha', status_note = 'CAPTCHA: run ./scripts/finish.sh on the Mac' WHERE id = ?", job.id);
        tell(`🧩 ${label} needs a CAPTCHA. Everything else is ready: run ./scripts/finish.sh on the Mac, solve it, press Submit.`);
        break;
      }
      run("UPDATE jobs SET status = 'manual', status_note = ? WHERE id = ?", res.reason || 'needs you', job.id);
      tell(`🖐 Couldn't finish ${label} (${res.reason}). Apply here yourself — the tailored resume is ready:\n${job.apply_url}`, { refKind: 'job', refId: job.id });
      break;
    case 'already_applied':
      run("UPDATE jobs SET status = 'applied', status_note = 'already applied before' WHERE id = ?", job.id);
      break;
    case 'closed':
      run("UPDATE jobs SET status = 'skipped', status_note = 'job closed' WHERE id = ?", job.id);
      break;
    case 'session_expired':
      run("UPDATE jobs SET status = 'queued', attempts = attempts - 1 WHERE id = ?", job.id);
      if (getKv(`session_${job.apply_type}`) !== 'expired') {
        run("INSERT INTO kv(key, value) VALUES(?, 'expired') ON CONFLICT(key) DO UPDATE SET value = 'expired'", `session_${job.apply_type}`);
        tell(`🔑 My ${job.apply_type} login expired. On the Mac run:\n  cd ~/job-agent && ./scripts/login.sh ${job.apply_type}\nUntil then I'll skip ${job.apply_type} jobs.`, { urgent: true });
      }
      break;
    case 'dry_run':                                   // form filled fine; submitted for real after "go live"
      run("UPDATE jobs SET status = 'ready', attempts = 0, status_note = ? WHERE id = ?", res.shot || 'dry run ok', job.id);
      event('dry_run', `${label} (${job.score}%) — form filled, not submitted`);
      break;
    default:
      run("UPDATE jobs SET status = ?, status_note = ? WHERE id = ?", (job.attempts || 0) + 1 >= 3 ? 'failed' : 'queued', (res.reason || res.status || '').slice(0, 300), job.id);
  }
  return res;
}

export function todayStats() {
  const since = Date.parse(`${istDate()}T00:00:00+05:30`);
  const c = (sql, ...p) => one(sql, ...p).n;
  return {
    found: c('SELECT count(*) n FROM jobs WHERE found_at >= ?', since),
    matched: c('SELECT count(*) n FROM jobs WHERE found_at >= ? AND score >= ?', since, config().min_score),
    applied: appliedToday(),
    queued: c("SELECT count(*) n FROM jobs WHERE status = 'queued'"),
    waiting: c("SELECT count(*) n FROM jobs WHERE status = 'needs_answer'"),
    manual: c("SELECT count(*) n FROM jobs WHERE status = 'manual' AND found_at >= ?", since),
    interviews: c("SELECT count(*) n FROM jobs WHERE status = 'interview'"),
    appliedTotal: c("SELECT count(*) n FROM jobs WHERE applied_at IS NOT NULL"),
  };
}
