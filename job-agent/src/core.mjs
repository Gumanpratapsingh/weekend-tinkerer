// Shared plumbing for the job agent: paths, logging, config, LLM calls, ntfy fallback, schedules.
import { readFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const HOME = homedir();
// One codebase, one agent process per person. JA_PERSON unset = the owner (profile/, data/, ~/.jobagent, port 8083).
// Anyone else lives in people/<name>/{profile,data} with secrets in ~/.jobagent-<name> and their own port (JA_PORT).
export const PERSON = process.env.JA_PERSON || '';
export const OWNER = !PERSON;
if (PERSON && !/^[a-z][a-z0-9_-]{0,30}$/.test(PERSON)) throw new Error(`bad JA_PERSON ${PERSON}`);
const BASE = OWNER ? ROOT : join(ROOT, 'people', PERSON);
export const PROFILE = join(BASE, 'profile');         // resume facts, config, answers, resume PDF
export const DATA = join(BASE, 'data');              // db, tailored resumes, screenshots — never in git
export const PORT = Number(process.env.JA_PORT || 8083);
export const AGENT_URL = `http://127.0.0.1:${PORT}`;
const SECRETS = join(HOME, OWNER ? '.jobagent' : `.jobagent-${PERSON}`);
mkdirSync(join(DATA, 'resumes'), { recursive: true, mode: 0o700 });
mkdirSync(join(DATA, 'shots'), { recursive: true, mode: 0o700 });

export const readJson = (f, fallback) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return fallback; } };
export const master = () => readJson(join(PROFILE, 'master.json'));
// config.json is safe to publish; private.json (gitignored) adds the mailbox and the person's known answers.
export const privateProfile = () => readJson(join(PROFILE, 'private.json'), {});
export const config = () => ({ ...readJson(join(PROFILE, 'config.json')), mailbox: privateProfile().mailbox });
// Per-person wording (master.json "persona"): school, career start, pitch lines. Code never hardcodes a person.
export const persona = () => master()?.persona || {};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function careerStart() {                      // {t: ms, label: "Aug 2024"} from persona.career_start "YYYY-MM"
  const [y, mo] = String(persona().career_start || '').split('-').map(Number);
  return y ? { t: Date.UTC(y, (mo || 1) - 1, 1), label: `${MONTHS[(mo || 1) - 1]} ${y}` } : null;
}
export const yearsWorked = () => { const c = careerStart(); return c ? (Date.now() - c.t) / (365.25 * 864e5) : Number(config().experience_years) || 0; };
// Has this person saved a login for a site (data/sessions/<site>.json, from scripts/login.sh)? No login, no browser work there.
export const hasSession = (site) => existsSync(join(DATA, 'sessions', `${site}.json`));
// Schedules marked { always: true } run during first-time setup; everything else waits until the profile exists.
export const gate = { open: true };
export const resumeFile = () => join(PROFILE, config().naukri_resume || 'resume.pdf');   // the person's original resume
export const secret = (name) => {                    // secrets live in ~/.jobagent[-<person>]/<name>, typed in by the person
  const f = join(SECRETS, name);
  return existsSync(f) ? readFileSync(f, 'utf8').trim() : '';
};

export function log(line) {
  const s = `${new Date().toISOString()} ${line}`;
  appendFileSync(join(DATA, 'agent.log'), s + '\n');
  activity(line.replace(/\/data\/data\/com\.termux\/files\/home\/jobagent\//g, ''));
  if (process.env.VERBOSE) console.log(s);
}
// Live activity feed for the hub's /jobs/live page (short lines; the agent and the browser worker both write here).
export function activity(text) {
  try { appendFileSync(join(DATA, 'activity.log'), `${new Date().toISOString()} ${String(text).replace(/\s*\n\s*/g, ' ⏎ ').slice(0, 400)}\n`); } catch { /* best effort */ }
}
// Every error, structured, in one file (data/errors.jsonl): the hub's /jobs/errors page groups and shows these.
export function logError(kind, err, ctx = {}) {
  const e = err instanceof Error ? err : new Error(String(err));
  const row = { at: new Date().toISOString(), src: 'agent', kind, message: String(e.message).slice(0, 600), stack: String(e.stack || '').slice(0, 2000), ctx };
  try { appendFileSync(join(DATA, 'errors.jsonl'), JSON.stringify(row) + '\n'); } catch { /* best effort */ }
  log(`${kind} error: ${e.message}`);
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- time (IST) ----------
export const IST = 5.5 * 3600e3;
export const istDate = (t = Date.now()) => new Date(t + IST).toISOString().slice(0, 10);
export const istHour = (t = Date.now()) => new Date(t + IST).getUTCHours();

// Run fn now-ish and then every `minutes`, never overlapping itself.
export function every(minutes, name, fn, { delay = 5000, always = false } = {}) {
  let running = false;
  const tick = async () => {
    if (running || (!gate.open && !always)) return;
    running = true;
    try { await fn(); } catch (e) { logError(name, e); }
    running = false;
  };
  setTimeout(tick, delay);
  setInterval(tick, minutes * 60e3);
}

// ---------- LLM: OpenAI-compatible free tiers, tried in order ----------
// Groq (3 models) + Google Gemini free tier (2 models), each with its own daily quota. No paid providers.
const PROVIDERS = [
  { name: 'groq', url: 'https://api.groq.com/openai/v1/chat/completions', key: () => secret('groq_key') || (OWNER ? readKey('.groq_key') : ''),   // never borrow the owner's quota
    // Three models with separate free quotas. qwen hides its reasoning with a different parameter.
    models: ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-20b'], extra: { reasoning_effort: 'low', include_reasoning: false },
    extraFor: { 'qwen/qwen3.8-27b': { reasoning_format: 'hidden' } } },
  { name: 'gemini', url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', key: () => secret('gemini_key'),
    models: ['gemini-flash-latest', 'gemini-3.5-flash-lite'], extra: { reasoning_effort: 'low' } },
];
function readKey(f) { try { return readFileSync(join(HOME, f), 'utf8').trim(); } catch { return ''; } }
const cooldown = new Map();                           // "provider/model" -> retry-after timestamp

export async function llm(messages, { maxTokens = 1200, json = false, temperature = 0.3, small = false, why = '' } = {}) {
  for (const p0 of PROVIDERS) {
    const p = small ? { ...p0, models: [...p0.models].reverse() } : p0;   // small: try the cheaper model first
    const key = p.key();
    if (!key) continue;
    for (const model of p.models) {
      const id = `${p.name}/${model}`;
      if ((cooldown.get(id) || 0) > Date.now()) continue;
      if (why) activity(`🤖 AI (${p.name} ${model.replace(/^openai\//, '')}): ${why}`);
      let r;
      try {
        r = await fetch(p.url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens, ...(p.extraFor?.[model] || p.extra),
            ...(json ? { response_format: { type: 'json_object' } } : {}) }),
          signal: AbortSignal.timeout(90000),
        });
      } catch (e) { log(`llm ${id} network: ${e.message}`); continue; }
      if (r.status === 429) {
        const wait = Number(r.headers.get('retry-after')) || 60;
        cooldown.set(id, Date.now() + Math.min(wait, 3600) * 1000);
        log(`llm ${id} rate limited for ${wait}s`);
        continue;
      }
      if (!r.ok) { log(`llm ${id} ${r.status}: ${(await r.text()).slice(0, 200)}`); continue; }
      const text = (await r.json()).choices?.[0]?.message?.content?.trim() || '';
      if (!json) return text;
      try { return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')); }
      catch { log(`llm ${id} returned bad json`); continue; }
    }
  }
  const e = new Error('All LLM providers are rate limited or failing'); e.rateLimited = true; throw e;
}

// ---------- ntfy: fallback channel when WhatsApp can't deliver ----------
export async function ntfy(title, body, { priority = 'default', tags = 'briefcase' } = {}) {
  const topic = OWNER ? readKey('room/ntfy-topic') : secret('ntfy_topic');   // each person's own private topic
  if (!topic) return;
  try {
    await fetch(`https://ntfy.sh/${topic}`, { method: 'POST', body,
      headers: { Title: title.replace(/[^\x20-\x7e]/g, ''), Priority: priority, Tags: tags } });
  } catch (e) { log(`ntfy: ${e.message}`); }
}
