// WhatsApp via Meta's Cloud API (free test number). The agent talks only to the owner's number.
// Secrets in ~/.jobagent/: wa_token, wa_phone_id, wa_app_secret, wa_verify_token, wa_owner (country code + number, no +).
// Meta only allows free-form messages within 24h of the owner's last message; outside that window the
// agent sends the pre-approved hello_world template plus an ntfy push, and holds messages until the owner replies.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { secret, log, ntfy, istHour, config } from './core.mjs';
import { getKv, setKv, all, run } from './db.mjs';

const API = 'https://graph.facebook.com/v21.0';
const WINDOW = 23.5 * 3600e3;
// WhatsApp stays off until Meta lets the account message (it needs a card + business verification): kv wa_enabled=1.
export const configured = () => !!(secret('wa_token') && secret('wa_phone_id') && secret('wa_owner') && getKv('wa_enabled') === '1');

run(`CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY, body TEXT NOT NULL, ref_kind TEXT, ref_id TEXT,
  urgent INTEGER DEFAULT 0, created_at INTEGER NOT NULL, sent_at INTEGER, wa_msg_id TEXT)`);

async function api(payload) {
  const r = await fetch(`${API}/${secret('wa_phone_id')}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret('wa_token')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: secret('wa_owner'), ...payload }),
    signal: AbortSignal.timeout(20000),
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`WhatsApp ${r.status}: ${out.error?.message || ''}`);
  return out.messages?.[0]?.id;
}

const windowOpen = () => Date.now() - Number(getKv('wa_last_inbound', 0)) < WINDOW;
const quiet = () => { const [from, to] = config().whatsapp_quiet_hours; const h = istHour(); return from > to ? h >= from || h < to : h >= from && h < to; };

/** Queue a message to the owner. ref links a reply back to a question/draft. Returns the outbox id. */
export function tell(body, { refKind = null, refId = null, urgent = false, options = null } = {}) {
  if (!configured()) {
    // Chat channel: Cupboard (the owner's chat app on this phone). Answers and button taps come back to
    // /internal/cupboard. ntfy + the hub /jobs page stay as the fallback until Cupboard can notify the owner.
    (async () => {
      if (await toCupboard(body, refKind, refId, options)) return;
      ntfy('Job agent', `${body.slice(0, 900)}${refKind === 'question' ? '\n\nAnswer on the hub: /jobs' : ''}`, { priority: urgent ? 'high' : 'default' });
    })().catch((e) => log(`tell: ${e.message}`));
    return;
  }
  run('INSERT INTO outbox(body, ref_kind, ref_id, urgent, created_at) VALUES(?,?,?,?,?)', body, refKind, refId ? String(refId) : null, urgent ? 1 : 0, Date.now());
  flush().catch((e) => log(`wa flush: ${e.message}`));
}

async function toCupboard(body, refKind, refId, options) {
  const ref = refKind ? { ref_kind: refKind, ref_id: String(refId) } : null;
  const actions = refKind === 'draft' ? [{ id: 'ok', label: '✓ Send', value: 'ok', style: 'go' }, { id: 'no', label: '✕ Discard', value: 'no' }]
    : refKind === 'question' && options?.length ? options.slice(0, 6).map((o, i) => ({ id: `o${i}`, label: String(o).slice(0, 30), value: String(o) })) : [];
  try {
    const r = await fetch('http://127.0.0.1:8086/notify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(4000),
      body: JSON.stringify({ title: 'Job agent', text: body.slice(0, 3900), ref, actions, replyTo: ref ? 'http://127.0.0.1:8083/internal/cupboard' : null }) });
    return r.ok && (await r.json()).pushable === true;
  } catch { return false; }
}

let flushing = false;
export async function flush() {
  if (flushing || !configured()) return;
  flushing = true;
  try {
    const rows = all('SELECT * FROM outbox WHERE sent_at IS NULL ORDER BY urgent DESC, id LIMIT 20');
    if (!rows.length) return;
    if (quiet() && !rows.some((r) => r.urgent)) return;
    if (!windowOpen()) {
      // Nudge at most every 6 hours: template message + phone push. Messages go out when the owner replies.
      if (Date.now() - Number(getKv('wa_nudged', 0)) > 6 * 3600e3) {
        setKv('wa_nudged', Date.now());
        await api({ type: 'template', template: { name: 'hello_world', language: { code: 'en_US' } } }).catch((e) => log(e.message));
        await ntfy('Job agent needs you', `${rows.length} message(s) waiting. Send "hi" to the agent on WhatsApp to receive them.`, { priority: 'high' });
      }
      return;
    }
    for (const r of rows) {
      const id = await api({ type: 'text', text: { body: r.body.slice(0, 4000), preview_url: false } });
      run('UPDATE outbox SET sent_at = ?, wa_msg_id = ? WHERE id = ?', Date.now(), id, r.id);
    }
  } finally { flushing = false; }
}

/** Send a PDF (e.g. the tailored resume) to the owner. */
export async function sendDocument(path, caption) {
  if (!configured() || !windowOpen()) return;
  const { readFileSync } = await import('node:fs');
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', 'application/pdf');
  form.append('file', new Blob([readFileSync(path)], { type: 'application/pdf' }), path.split('/').pop());
  const up = await fetch(`${API}/${secret('wa_phone_id')}/media`, { method: 'POST', headers: { Authorization: `Bearer ${secret('wa_token')}` }, body: form });
  const { id } = await up.json();
  if (id) await api({ type: 'document', document: { id, caption, filename: path.split('/').pop() } });
}

/** Webhook handler. Returns {status, body} for the HTTP layer. onMessage(text, repliedToRef) handles owner messages. */
export async function webhook(method, query, rawBody, headers, onMessage) {
  if (method === 'GET') {
    const ok = query['hub.mode'] === 'subscribe' && query['hub.verify_token'] && query['hub.verify_token'] === secret('wa_verify_token');
    return ok ? { status: 200, body: query['hub.challenge'] } : { status: 403, body: 'forbidden' };
  }
  const sig = String(headers['x-hub-signature-256'] || '');
  const want = 'sha256=' + createHmac('sha256', secret('wa_app_secret')).update(rawBody).digest('hex');
  if (!secret('wa_app_secret') || sig.length !== want.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(want))) {
    log('wa webhook: bad signature');
    return { status: 401, body: 'bad signature' };
  }
  const data = JSON.parse(rawBody);
  // Delivery reports: log failures so a silent non-delivery is visible.
  for (const entry of data.entry || []) for (const ch of entry.changes || []) for (const st of ch.value?.statuses || []) {
    log(`wa status ${st.status}${st.errors ? ' ' + JSON.stringify(st.errors).slice(0, 300) : ''}`);
  }
  for (const entry of data.entry || []) for (const ch of entry.changes || []) for (const msg of ch.value?.messages || []) {
    if (msg.from !== secret('wa_owner')) { log(`wa: ignored message from ${msg.from}`); continue; }
    if (getKv(`wa_seen_${msg.id}`)) continue;                     // Meta retries deliveries
    setKv(`wa_seen_${msg.id}`, 1);
    setKv('wa_last_inbound', Date.now());
    const text = msg.text?.body || msg.button?.text || msg.interactive?.button_reply?.title || '';
    const ctx = msg.context?.id ? all('SELECT ref_kind, ref_id FROM outbox WHERE wa_msg_id = ?', msg.context.id)[0] : null;
    try { await onMessage(text.trim(), ctx); } catch (e) { log(`wa handler: ${e.stack || e.message}`); tell(`⚠️ Error: ${e.message}`); }
  }
  flush().catch((e) => log(`wa flush: ${e.message}`));
  return { status: 200, body: 'ok' };
}
