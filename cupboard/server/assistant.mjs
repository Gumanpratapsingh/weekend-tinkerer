// "Assistant ✨": a chat shared by everyone in Cupboard where they ask anything (wedding prep, skin, nails, outfits,
// fitness, plans). The AI answers and can act in the app: reminders, list items, and new-feature ideas, which go to
// the "💡 Feature ideas" list for Guman to build later. Photos sent here are looked at too (Gemini).
// It has its OWN free key so it never eats the job agents' Groq quota:
//   ~/.cupboard_gemini_key (Google AI Studio, preferred: also reads photos) and/or ~/.cupboard_groq_key.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { one, all, run, HOME, MEDIA, botId, owner, getKv, setKv } from './db.mjs';
import { fmt } from './together.mjs';

const IST = 5.5 * 3600e3;
const NAME = 'Assistant ✨';
const keyOf = (f) => { try { return readFileSync(join(HOME, f), 'utf8').trim(); } catch { return ''; } };
const PROVIDERS = () => [
  { name: 'gemini', key: keyOf('.cupboard_gemini_key'), url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    // Free-tier daily limits differ a lot per model (some only 20 a day); a model that says "quota used up" rests for an hour.
    models: ['gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-flash-lite-latest'], images: true, extra: { reasoning_effort: 'low' } },
  { name: 'groq', key: keyOf('.cupboard_groq_key'), url: 'https://api.groq.com/openai/v1/chat/completions',
    models: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'], images: false, extra: { reasoning_effort: 'low', include_reasoning: false } },
].filter((p) => p.key).concat(process.env.CUPBOARD_AI_TEST_URL   // tests only: a local stand-in for the AI
  ? [{ name: 'test', key: 'test', url: process.env.CUPBOARD_AI_TEST_URL, models: ['test'], images: true, extra: {} }] : []);

const istNow = () => { const d = new Date(Date.now() + IST); return `${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getUTCDay()]} ${d.toISOString().slice(0, 16).replace('T', ' ')}`; };
const fromIst = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(s || '')); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - IST : NaN; };

export function install({ postMessage, emit, memberIds, together, log }) {
  // The chat itself: a group with the owner and every active friend, made once.
  function ensureConv() {
    const id = Number(getKv('assistant_conv'));
    if (id && one('SELECT 1 FROM convs WHERE id = ?', id)) return id;
    const o = owner();
    if (!o) return null;
    const people = [o.id, ...all("SELECT id FROM users WHERE active = 1 AND role = 'friend'").map((r) => r.id)];
    const now = Date.now();
    const conv = Number(run("INSERT INTO convs(kind, name, created_by, created) VALUES('group', ?, ?, ?)", NAME, o.id, now).lastInsertRowid);
    for (const uid of people) run('INSERT INTO members(conv_id, user_id) VALUES(?, ?)', conv, uid);
    run("INSERT INTO messages(conv_id, user_id, kind, text, extra, created) VALUES(?, ?, 'card', ?, ?, ?)", conv, botId(),
      'Ask me anything: wedding prep, skin, hair, nails, outfits, fitness, food, plans. I can also set reminders ("remind me Saturday 11am to call the tailor"), ' +
      'add to your lists ("add mojari and jhumkas to Shopping"), and note app features you want later ("we need an outfit fitting tracker"). Send a photo and I\'ll take a look.',
      JSON.stringify({ title: '✨ Assistant' }), now);
    if (!getKv('assistant_context')) setKv('assistant_context', 'Guman and Vertika are engaged; their wedding is on 12 December 2026.');
    setKv('assistant_conv', conv);
    log(`assistant chat ${conv} created`);
    return conv;
  }
  ensureConv();
  const isAssistant = (convId) => Number(getKv('assistant_conv')) === convId;
  // Quiet mode (the 🤫 button): it only answers messages that start with "@ai" (or "assistant").
  const quiet = () => getKv('assistant_quiet') === '1';
  const shouldReply = (text) => !quiet() || /^\s*@?(ai|assistant)\b/i.test(String(text || ''));
  async function setQuiet(me, convId, on) {
    setKv('assistant_quiet', on ? '1' : '');
    await postMessage(convId, botId(), { kind: 'text', text: on ? `🤫 Okay, I'll stay quiet (${me.name.split(' ')[0]} pressed mute). Start a message with @ai when you need me.` : `✨ I'm back (${me.name.split(' ')[0]} woke me up). I'll answer every message again.` }, { pushOnly: [] });
  }

  const used = new Map();                                     // userId -> timestamps (40 questions an hour each)
  const allowed = (uid) => { const r = (used.get(uid) || []).filter((t) => Date.now() - t < 3600e3); r.push(Date.now()); used.set(uid, r); return r.length <= 40; };

  const resting = new Map();                                  // "provider/model" -> until
  async function ask(messages, hasImage) {
    for (const p of PROVIDERS()) {
      if (hasImage && !p.images) continue;
      for (const model of p.models) {
        if ((resting.get(`${p.name}/${model}`) || 0) > Date.now()) continue;
        try {
          const r = await fetch(p.url, { method: 'POST', headers: { Authorization: `Bearer ${p.key}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(60000),
            body: JSON.stringify({ model, messages, temperature: 0.4, max_tokens: 1500, response_format: { type: 'json_object' }, ...p.extra }) });
          if (r.status === 429) resting.set(`${p.name}/${model}`, Date.now() + 3600e3);
          if (!r.ok) { log(`assistant ${p.name}/${model} ${r.status}`); continue; }
          const text = (await r.json()).choices?.[0]?.message?.content || '';
          return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
        } catch (e) { log(`assistant ${p.name}/${model}: ${e.message}`); }
      }
    }
    return null;
  }

  async function reply(me, convId) {
    const say = (text, extra = null) => postMessage(convId, botId(), { kind: extra ? 'card' : 'text', text, extra }, { pushOnly: [me.id], pushAs: { title: '✨ Assistant', body: text.slice(0, 170) } });
    if (!PROVIDERS().length) return say('I need my own free AI key before I can answer (so I don\'t slow down the job agents). Guman: see the setup note from Claude.');
    if (!allowed(me.id)) return say('That\'s a lot of questions this hour. Give me a few minutes.');
    for (const uid of memberIds(convId)) if (uid !== me.id) emit(uid, 'typing', { conv: convId, user: botId(), name: 'Assistant' });
    emit(me.id, 'typing', { conv: convId, user: botId(), name: 'Assistant' });

    // What the AI knows: the last messages here, who is who, today's date, their lists and what's coming up.
    const bot = botId();
    const names = Object.fromEntries(all('SELECT id, name FROM users').map((u) => [u.id, u.name.split(' ')[0]]));
    const rows = all("SELECT * FROM messages WHERE conv_id = ? AND kind IN ('text', 'card', 'image') ORDER BY id DESC LIMIT 16", convId).reverse();
    const last = rows[rows.length - 1];
    const providerImages = PROVIDERS().some((p) => p.images);
    const history = rows.map((m) => {
      if (m.user_id === bot) return { role: 'assistant', content: JSON.stringify({ reply: m.text || '' }) };
      const content = `${names[m.user_id] || 'Someone'}: ${m.kind === 'image' ? `[sent a photo]${m.text ? ` ${m.text}` : ''}` : m.text || ''}`;
      if (m === last && m.kind === 'image' && providerImages && m.media) {
        try {
          const [file, type] = m.media.split('|');
          return { role: 'user', content: [{ type: 'text', text: content }, { type: 'image_url', image_url: { url: `data:${type};base64,${readFileSync(join(MEDIA, file)).toString('base64')}` } }] };
        } catch { /* file gone */ }
      }
      return { role: 'user', content };
    });
    const convs = all('SELECT conv_id FROM members WHERE user_id = ?', me.id).map((r) => r.conv_id);
    const q = convs.map(() => '?').join(',');
    const lists = all(`SELECT l.title, (SELECT count(*) FROM list_items i WHERE i.list_id = l.id AND i.done = 0) AS open FROM lists l WHERE l.archived = 0 AND l.conv_id IN (${q})`, ...convs);
    const events = all(`SELECT * FROM events WHERE conv_id IN (${q}) AND (for_all = 1 OR created_by = ?) AND remind_at > ? ORDER BY remind_at LIMIT 8`, ...convs, me.id, Date.now());
    const system = `You are the assistant inside Cupboard, the private chat app of ${Object.values(names).filter((n) => n !== 'S20').join(' and ')}. ${getKv('assistant_context') || ''}
It is now ${istNow()} in India (IST). You are talking with ${names[me.id]}.
Help with anything: wedding prep, skin, hair, nails, grooming, outfits, fitness, food, planning, everyday questions. Be warm, practical and short
(under 120 words unless they ask for detail); plain text, simple "- " lists are fine. Skin, health and diet advice is general wellness, not medical:
for anything medical (infections, pain, sudden changes, medicines) say to see a doctor or dermatologist. If a photo is attached, describe what you see and help.
You can act in the app. Reply with JSON only:
{"reply":"...","actions":[...]}
Actions (only ones they asked for or clearly want; never invent dates they did not imply):
- {"type":"reminder","title":"short, with an emoji","at":"YYYY-MM-DDTHH:MM" (IST),"repeat":null|"daily"|"weekly"|"monthly","for":"me"|"both"}
- {"type":"list","list":"list name","emoji":"one emoji","items":["..."]}  (adds to their list with that name, or starts a new shared list)
- {"type":"idea","text":"the feature, in one sentence"}  when they want something the app cannot do yet; it is saved to the "Feature ideas" list
  for Guman to build later. Say that in your reply.
Their lists: ${lists.map((l) => `${l.title} (${l.open} open)`).join(', ') || 'none yet'}.
Coming up: ${events.map((e) => `${fmt(e.remind_at)} ${e.title}`).join('; ') || 'nothing'}.`;

    const out = await ask([{ role: 'system', content: system }, ...history], last?.kind === 'image' && providerImages);
    if (!out) return say('Sorry, I couldn\'t think just now (the free AI is busy). Try again in a minute.');

    // Carry out what it asked for, checked and capped; tell them what was done.
    const done = [];
    const health = (uid) => one("SELECT c.id FROM convs c JOIN members m ON m.conv_id = c.id WHERE c.kind = 'group' AND c.name LIKE 'Health & glow%' AND m.user_id = ?", uid)?.id;
    for (const a of (Array.isArray(out.actions) ? out.actions : []).slice(0, 5)) {
      try {
        if (a.type === 'reminder') {
          const at = fromIst(a.at);
          if (!a.title || !Number.isFinite(at) || at < Date.now() - 60e3 || at > Date.now() + 3 * 365 * 86400e3) continue;
          const mine = a.for === 'me';
          // "Just me" goes to the person's own Health & glow chat; "both" stays here for everyone.
          const conv = mine ? health(me.id) || convId : convId;
          together.addReminder({ conv, title: String(a.title), at, forAll: !mine || conv !== convId, repeat: a.repeat, by: me.id });
          done.push(`⏰ ${String(a.title).slice(0, 60)} · ${fmt(at)}${a.repeat ? ` · every ${{ daily: 'day', weekly: 'week', monthly: 'month' }[a.repeat] || ''}` : ''}${mine ? ' (just you)' : ''}`);
        } else if (a.type === 'list' && a.list && Array.isArray(a.items) && a.items.length) {
          const l = together.addToList({ convs, conv: convId, name: String(a.list), emoji: a.emoji, items: a.items, by: me.id });
          done.push(`📝 Added ${a.items.length} to ${l.title}`);
        } else if (a.type === 'idea' && a.text) {
          together.addToList({ convs: [convId], conv: convId, name: 'Feature ideas', emoji: '💡', items: [`${String(a.text).slice(0, 180)} (${names[me.id]})`], by: me.id });
          done.push('💡 Saved to Feature ideas');
        }
      } catch (e) { log('assistant action', e.message); }
    }
    const text = String(out.reply || '').trim().slice(0, 3500) || (done.length ? 'Done.' : 'Hmm, could you say that another way?');
    return say(done.length ? `${text}\n\n${done.join('\n')}` : text);
  }

  return { isAssistant, reply, ensureConv, quiet, shouldReply, setQuiet };
}
