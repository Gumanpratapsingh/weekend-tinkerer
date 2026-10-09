// Telegram bot channel (free, official, no card): the agent talks only to the owner's linked chat.
// Secret: ~/.jobagent/tg_token (from @BotFather). Linking: scripts/link-telegram.sh puts a one-time code in kv;
// the owner sends "/start <code>" to the bot and that chat becomes the only one the agent listens to.
// Long polling (getUpdates), so nothing about the bot is exposed on the phone's public site.
import { secret, log, istHour, config } from './core.mjs';
import { getKv, setKv, all, one, run } from './db.mjs';

const api = async (method, body) => {
  const r = await fetch(`https://api.telegram.org/bot${secret('tg_token')}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(method === 'getUpdates' ? 70000 : 20000),
  });
  const out = await r.json().catch(() => ({}));
  if (!out.ok) throw new Error(`Telegram ${method}: ${out.description || r.status}`);
  return out.result;
};

export const configured = () => !!(secret('tg_token') && getKv('tg_chat'));

run(`CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY, body TEXT NOT NULL, ref_kind TEXT, ref_id TEXT,
  urgent INTEGER DEFAULT 0, created_at INTEGER NOT NULL, sent_at INTEGER, wa_msg_id TEXT)`);

const quiet = () => { const [from, to] = config().whatsapp_quiet_hours; const h = istHour(); return from > to ? h >= from || h < to : h >= from && h < to; };

// Buttons: drafts get Send/Discard; questions with a few options get one button per option.
function keyboard(row) {
  if (row.ref_kind === 'draft') return [[{ text: '✅ Send', callback_data: `d:${row.ref_id}:ok` }, { text: '✖️ Discard', callback_data: `d:${row.ref_id}:no` }]];
  if (row.ref_kind === 'question') {
    const q = one('SELECT options FROM questions WHERE id = ?', Number(row.ref_id));
    const opts = q?.options ? JSON.parse(q.options) : [];
    if (opts.length && opts.length <= 8) return opts.map((o, i) => [{ text: String(o).slice(0, 60), callback_data: `q:${row.ref_id}:${i}` }]);
  }
  return null;
}

export function tell(body, { refKind = null, refId = null, urgent = false } = {}) {
  run('INSERT INTO outbox(body, ref_kind, ref_id, urgent, created_at) VALUES(?,?,?,?,?)', body, refKind, refId ? String(refId) : null, urgent ? 1 : 0, Date.now());
  flush().catch((e) => log(`tg flush: ${e.message}`));
}

let flushing = false;
export async function flush() {
  if (flushing || !configured()) return;
  flushing = true;
  try {
    const rows = all('SELECT * FROM outbox WHERE sent_at IS NULL ORDER BY urgent DESC, id LIMIT 25');
    if (!rows.length || (quiet() && !rows.some((r) => r.urgent))) return;
    for (const r of rows) {
      if (quiet() && !r.urgent) continue;
      const kb = keyboard(r);
      const m = await api('sendMessage', { chat_id: getKv('tg_chat'), text: r.body.slice(0, 4000), disable_web_page_preview: true,
        ...(kb ? { reply_markup: { inline_keyboard: kb } } : {}) });
      run('UPDATE outbox SET sent_at = ?, wa_msg_id = ? WHERE id = ?', Date.now(), String(m.message_id), r.id);
    }
  } finally { flushing = false; }
}

export async function sendDocument(path, caption) {
  if (!configured()) return;
  const { readFileSync } = await import('node:fs');
  const form = new FormData();
  form.append('chat_id', getKv('tg_chat'));
  form.append('caption', String(caption || '').slice(0, 1000));
  form.append('document', new Blob([readFileSync(path)], { type: 'application/pdf' }), path.split('/').pop());
  await fetch(`https://api.telegram.org/bot${secret('tg_token')}/sendDocument`, { method: 'POST', body: form });
}

// Poll for the owner's messages and button taps forever. onMessage(text, ref) is the same handler WhatsApp used.
export async function listen(onMessage) {
  for (;;) {
    if (!secret('tg_token')) { await new Promise((r) => setTimeout(r, 60000)); continue; }
    try {
      const updates = await api('getUpdates', { offset: Number(getKv('tg_offset', 0)), timeout: 50, allowed_updates: ['message', 'callback_query'] });
      for (const u of updates) {
        setKv('tg_offset', u.update_id + 1);
        const msg = u.message || u.callback_query?.message;
        const chat = String(msg?.chat?.id || '');
        // Linking: "/start <code>" with the one-time code from scripts/link-telegram.sh.
        const code = /^\/start\s+(\S+)/.exec(u.message?.text || '')?.[1];
        if (code && getKv('tg_link_code') && code === getKv('tg_link_code')) {
          setKv('tg_chat', chat); setKv('tg_link_code', '');
          log(`telegram linked to chat ${chat}`);
          await api('sendMessage', { chat_id: chat, text: '🔗 Linked. I will only talk to this chat. Sending your setup questions now.' });
          run('UPDATE outbox SET urgent = 1 WHERE sent_at IS NULL');
          await flush();
          continue;
        }
        if (!chat || chat !== getKv('tg_chat')) { log(`telegram: ignored update from chat ${chat || '?'}`); continue; }
        try {
          if (u.callback_query) {
            const [kind, id, val] = String(u.callback_query.data || '').split(':');
            await api('answerCallbackQuery', { callback_query_id: u.callback_query.id }).catch(() => {});
            if (kind === 'd') await onMessage(val === 'ok' ? 'ok' : 'no', { ref_kind: 'draft', ref_id: id });
            if (kind === 'q') {
              const q = one('SELECT options FROM questions WHERE id = ?', Number(id));
              const opt = q?.options ? JSON.parse(q.options)[Number(val)] : null;
              if (opt != null) await onMessage(String(opt), { ref_kind: 'question', ref_id: id });
            }
            continue;
          }
          const replyTo = u.message.reply_to_message?.message_id;
          const ref = replyTo ? all('SELECT ref_kind, ref_id FROM outbox WHERE wa_msg_id = ?', String(replyTo))[0] : null;
          await onMessage(String(u.message.text || '').trim(), ref);
        } catch (e) { log(`tg handler: ${e.stack || e.message}`); tell(`⚠️ Error: ${e.message}`); }
      }
      await flush();
    } catch (e) { log(`tg poll: ${e.message}`); await new Promise((r) => setTimeout(r, 10000)); }
  }
}
