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

// The AI sometimes puts raw line breaks inside the reply string, which strict JSON rejects. Repair that, and if it
// isn't JSON at all use its text as the reply, so an answer is never thrown away.
function parseLoose(text) {
  const t = String(text || '').replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '');
  try { return JSON.parse(t); } catch { /* repair below */ }
  let out = '', inStr = false, esc = false;
  for (const ch of t) {
    if (inStr) {
      if (esc) { esc = false; out += ch; }
      else if (ch === '\\') { esc = true; out += ch; }
      else if (ch === '"') { inStr = false; out += ch; }
      else if (ch === '\n') out += '\\n'; else if (ch === '\r') out += ''; else if (ch === '\t') out += '\\t';
      else out += ch;
    } else { if (ch === '"') inStr = true; out += ch; }
  }
  try { return JSON.parse(out); } catch { /* not repairable */ }
  const m = /"reply"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(t);
  if (m) { try { return { reply: JSON.parse(`"${m[1]}"`), actions: [] }; } catch { return { reply: m[1].replace(/\\n/g, '\n'), actions: [] }; } }
  return t.trim() ? { reply: t.trim(), actions: [] } : null;
}
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
  // Health & glow chats: the personal wellness chat each person has. Photos get feedback; a question (ends with ?) or
  // a message starting with "@ai" gets an answer; everything else is left alone (it is mostly reminders).
  const isCoach = (convId) => !!one("SELECT 1 FROM convs WHERE id = ? AND kind = 'group' AND name LIKE 'Health & glow%'", convId);
  const coachWants = (text) => /\?\s*$/.test(String(text || '')) || /^\s*@?(ai|coach|assistant)\b/i.test(String(text || ''));
  // Photos arrive one by one (two hands = two photos): wait until they stop coming, then answer all of them once.
  const pending = new Map();
  function onImage(me, convId, caption) {
    if (isAssistant(convId) ? !shouldReply(caption) : !isCoach(convId)) return;
    clearTimeout(pending.get(`${convId}:${me.id}`));
    pending.set(`${convId}:${me.id}`, setTimeout(() => { pending.delete(`${convId}:${me.id}`); reply(me, convId).catch((e) => log('assistant', e.message)); }, 8000));
  }
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
          const out = parseLoose(text);
          if (out) return out;
          log(`assistant ${p.name}/${model}: empty answer`);
        } catch (e) { log(`assistant ${p.name}/${model}: ${e.message}`); }
      }
    }
    return null;
  }

  async function reply(me, convId) {
    const coach = isCoach(convId);
    const say = (text, extra = null) => postMessage(convId, botId(), { kind: extra ? 'card' : 'text', text, extra }, { pushOnly: [me.id], pushAs: { title: coach ? '🌿 Coach' : '✨ Assistant', body: text.slice(0, 170) } });
    if (!PROVIDERS().length) return say('I need my own free AI key before I can answer (so I don\'t slow down the job agents). Guman: see the setup note from Claude.');
    if (!allowed(me.id)) return say('That\'s a lot of questions this hour. Give me a few minutes.');
    for (const uid of memberIds(convId)) if (uid !== me.id) emit(uid, 'typing', { conv: convId, user: botId(), name: 'Assistant' });
    emit(me.id, 'typing', { conv: convId, user: botId(), name: 'Assistant' });

    // What the AI knows: the last messages here, who is who, today's date, their lists and what's coming up.
    const bot = botId();
    const names = Object.fromEntries(all('SELECT id, name FROM users').map((u) => [u.id, u.name.split(' ')[0]]));
    // In a coach chat the reminder cards are left out; only what people and the coach said counts.
    const rows = all(`SELECT * FROM messages WHERE conv_id = ? AND kind IN (${coach ? "'text', 'image'" : "'text', 'card', 'image'"}) ORDER BY id DESC LIMIT 16`, convId).reverse();
    const providerImages = PROVIDERS().some((p) => p.images);
    const imgPart = (m) => {
      try { const [file, type] = m.media.split('|'); return { type: 'image_url', image_url: { url: `data:${type};base64,${readFileSync(join(MEDIA, file)).toString('base64')}` } }; } catch { return null; }
    };
    // The newest photos this person just sent (up to 4, as one batch), looked at together.
    const batch = [];
    for (let i = rows.length - 1; i >= 0 && rows[i].kind === 'image' && rows[i].user_id === me.id && batch.length < 4; i--) batch.unshift(rows[i]);
    const earlier = rows.slice(0, rows.length - batch.length);
    const history = earlier.map((m) => {
      if (m.user_id === bot) return { role: 'assistant', content: JSON.stringify({ reply: m.text || '' }) };
      return { role: 'user', content: `${names[m.user_id] || 'Someone'}: ${m.kind === 'image' ? `[sent a photo]${m.text ? ` ${m.text}` : ''}` : m.text || ''}` };
    });
    let hasImage = false;
    if (batch.length) {
      const parts = [{ type: 'text', text: `${names[me.id]}: [sent ${batch.length} photo${batch.length > 1 ? 's' : ''}${batch.some((m) => m.text) ? `: ${batch.map((m) => m.text).filter(Boolean).join(' / ')}` : ''}]` }];
      if (providerImages) for (const m of batch) { const part = m.media && imgPart(m); if (part) { parts.push(part); hasImage = true; } }
      // A coach chat keeps the first photos as the baseline: show them too once a couple of weeks have passed.
      if (coach && hasImage) {
        const first = all("SELECT * FROM messages WHERE conv_id = ? AND user_id = ? AND kind = 'image' ORDER BY id LIMIT 2", convId, me.id)
          .filter((m) => m.created < batch[0].created - 14 * 86400e3 && m.media);
        if (first.length) {
          parts.push({ type: 'text', text: `For comparison, the FIRST photos from ${new Date(first[0].created + IST).toISOString().slice(0, 10)}:` });
          for (const m of first) { const part = imgPart(m); if (part) parts.push(part); }
        }
      }
      history.push({ role: 'user', content: hasImage ? parts : parts[0].text });
    }
    const convs = all('SELECT conv_id FROM members WHERE user_id = ?', me.id).map((r) => r.conv_id);
    const q = convs.map(() => '?').join(',');
    const lists = all(`SELECT l.title, (SELECT count(*) FROM list_items i WHERE i.list_id = l.id AND i.done = 0) AS open FROM lists l WHERE l.archived = 0 AND l.conv_id IN (${q})`, ...convs);
    const events = all(`SELECT * FROM events WHERE conv_id IN (${q}) AND (for_all = 1 OR created_by = ?) AND remind_at > ? ORDER BY remind_at LIMIT 8`, ...convs, me.id, Date.now());
    const COACH = `You are the personal prep coach in ${names[me.id]}'s private "Health & glow" chat. ${names[me.id]} is the ${me.role === 'owner' ? 'groom' : 'bride'} and the wedding is on 12 December 2026.
Their daily routine (sent as reminders here): skin care morning and night, water, protein-rich light meals, 8,000-10,000 steps, workouts, sleep by 11, and a nail plan:
cuticle oil + hand cream every night, gloves for dishes, no biting or picking, and on Sundays trim straight, file one direction, push cuticles back after a shower (never cut), buff ridges lightly every 2nd week.
Photo check-ins are Sundays; the nail check-points are day 0 (12 Oct), day 30 (11 Nov), day 60 (11 Dec).
When they send photos: say what you actually see in each (for nails: shape and length, cuticles, ridges, peeling or splitting, colour, dryness, signs of biting; for face/hair/body: only
what is visible), what is already good, and the 2-3 most useful things to do next. If earlier photos are attached for comparison, say what changed. If one hand or angle is missing, ask for it.
Never diagnose: for yellow, thick, painful, very dark or sudden changes, an infection (redness, swelling, pus), or anything that worries you, tell them to see a dermatologist.
Be kind and specific, never harsh about looks.`;
    const system = `${coach ? COACH + '\n' : ''}You are the assistant inside Cupboard, the private chat app of ${Object.values(names).filter((n) => n !== 'S20').join(' and ')}. ${getKv('assistant_context') || ''}
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

    const out = await ask([{ role: 'system', content: system }, ...history], hasImage);
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

  // Said once in each Health & glow chat, so people know photos and questions get an answer there.
  for (const c of all("SELECT c.id, m.user_id FROM convs c JOIN members m ON m.conv_id = c.id WHERE c.kind = 'group' AND c.name LIKE 'Health & glow%'")) {
    if (getKv(`coach_note:${c.id}`)) continue;
    setKv(`coach_note:${c.id}`, '1');
    postMessage(c.id, botId(), { kind: 'text', text: '🌿 Send me your photos here (nails, face, hair) and I\'ll give you feedback. Take both hands, then send them together. ' +
      'You can also ask me a question: end it with "?" or start with @ai.\n' +
      '🔒 Photos you send in this chat are looked at by Google\'s Gemini AI to answer you, so keep private or intimate ones out of here.' }, { pushOnly: [c.user_id], pushAs: { title: '🌿 Coach', body: 'Send your photos here and I\'ll give you feedback.' } }).catch(() => {});
  }

  // One-time privacy note in the Assistant chat as well: its photos go to the AI too.
  const ac = Number(getKv('assistant_conv'));
  if (ac && !getKv('assistant_privacy_note')) {
    setKv('assistant_privacy_note', '1');
    postMessage(ac, botId(), { kind: 'text', text: '🔒 Heads-up: photos and messages you send in this chat are read by Google\'s Gemini AI so I can answer. Keep private or intimate photos out of here (the chat between the two of you does not use AI).' }, { pushOnly: [] }).catch(() => {});
  }

  return { isAssistant, isCoach, coachWants, onImage, reply, ensureConv, quiet, shouldReply, setQuiet };
}
