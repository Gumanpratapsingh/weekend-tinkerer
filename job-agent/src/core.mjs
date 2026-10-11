// Shared plumbing for the job agent: paths, logging, config, LLM calls, ntfy fallback, schedules.
import { readFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const HOME = homedir();
export const DATA = join(ROOT, 'data');              // db, tailored resumes, screenshots — never in git
mkdirSync(join(DATA, 'resumes'), { recursive: true, mode: 0o700 });
mkdirSync(join(DATA, 'shots'), { recursive: true, mode: 0o700 });

export const readJson = (f, fallback) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return fallback; } };
export const master = () => readJson(join(ROOT, 'profile', 'master.json'));
// config.json is safe to publish; private.json (gitignored) adds the mailbox and the owner's known answers.
export const privateProfile = () => readJson(join(ROOT, 'profile', 'private.json'), {});
export const config = () => ({ ...readJson(join(ROOT, 'profile', 'config.json')), mailbox: privateProfile().mailbox });
export const secret = (name) => {                    // secrets live in ~/.jobagent/<name>, typed in by the owner
  const f = join(HOME, '.jobagent', name);
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
export function every(minutes, name, fn, { delay = 5000 } = {}) {
  let running = false;
  const tick = async () => {
    if (running) return;
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
  { name: 'groq', url: 'https://api.groq.com/openai/v1/chat/completions', key: () => readKey('.groq_key'),
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
  const topic = readKey('room/ntfy-topic');
  if (!topic) return;
  try {
    await fetch(`https://ntfy.sh/${topic}`, { method: 'POST', body,
      headers: { Title: title.replace(/[^\x20-\x7e]/g, ''), Priority: priority, Tags: tags } });
  } catch (e) { log(`ntfy: ${e.message}`); }
}
