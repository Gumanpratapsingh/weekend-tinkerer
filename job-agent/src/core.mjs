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
  if (process.env.VERBOSE) console.log(s);
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
    try { await fn(); } catch (e) { log(`${name} error: ${e.stack || e.message}`); }
    running = false;
  };
  setTimeout(tick, delay);
  setInterval(tick, minutes * 60e3);
}

// ---------- LLM: OpenAI-compatible free tiers, tried in order ----------
// Groq is required; Cerebras / Gemini keys are optional extra daily budget if the owner adds them.
const PROVIDERS = [
  { name: 'groq', url: 'https://api.groq.com/openai/v1/chat/completions', key: () => readKey('.groq_key'),
    models: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'], extra: { reasoning_effort: 'low', include_reasoning: false } },
  { name: 'cerebras', url: 'https://api.cerebras.ai/v1/chat/completions', key: () => secret('cerebras_key'),
    models: ['gpt-oss-120b'], extra: {} },
  { name: 'gemini', url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', key: () => secret('gemini_key'),
    models: ['gemini-2.5-flash'], extra: { reasoning_effort: 'low' } },
];
function readKey(f) { try { return readFileSync(join(HOME, f), 'utf8').trim(); } catch { return ''; } }
const cooldown = new Map();                           // "provider/model" -> retry-after timestamp

export async function llm(messages, { maxTokens = 1200, json = false, temperature = 0.3 } = {}) {
  for (const p of PROVIDERS) {
    const key = p.key();
    if (!key) continue;
    for (const model of p.models) {
      const id = `${p.name}/${model}`;
      if ((cooldown.get(id) || 0) > Date.now()) continue;
      let r;
      try {
        r = await fetch(p.url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens, ...p.extra,
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
