// One-to-one video calls (WebRTC). The laptop only carries the small "signalling" messages (who is calling, the
// connection offer/answer, network candidates); the video and audio themselves go phone to phone, or through a relay
// when the two are on different networks (her mobile data and your home WiFi). Calls are end-to-end encrypted by WebRTC.
//
// A relay is only needed when no direct path exists. Its key lives on the laptop in ~/.cupboard_turn.json, one of:
//   {"keyId": "...", "apiToken": "..."}                    Cloudflare Realtime TURN (needs a card on file with Cloudflare)
//   {"metered": {"app": "<name>", "apiKey": "..."}}        Metered.ca free plan (500 MB a month, no card)
//   {"iceServers": [ ...any list of STUN/TURN servers... ]}
// Without one, calls still connect when a direct path exists: same WiFi, IPv6 on both phones, or a friendly NAT.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { one, all, HOME, botId } from './db.mjs';

const RING_MS = 45e3;
const MAX_CALL_MS = 4 * 3600e3;
const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

export function install({ emit, canSee, readJson, send, err, postMessage, notify, isActive, log }) {
  const calls = new Map();          // call id -> call
  const busy = new Map();           // user id -> call id (one call at a time each)
  let iceCache = null;
  const logRate = new Map();

  const first = (id) => one('SELECT name FROM users WHERE id = ?', id)?.name?.split(' ')[0] || 'Someone';
  const peerOf = (c, uid) => (uid === c.from ? c.to : c.from);
  const view = (c, uid) => ({ id: c.id, conv: c.conv, state: c.state, role: uid === c.from ? 'caller' : 'callee', peer: { id: peerOf(c, uid), name: one('SELECT name FROM users WHERE id = ?', peerOf(c, uid))?.name } });

  // ----- network helpers for the browsers: STUN always, the relay when its key is set -----
  const readCfg = () => { try { return JSON.parse(readFileSync(join(HOME, '.cupboard_turn.json'), 'utf8')); } catch { return null; } };
  async function iceServers() {
    if (iceCache && Date.now() < iceCache.until) return iceCache.value;
    const cfg = readCfg();
    let value = { iceServers: [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }], relay: false };
    let ttl = 60e3;
    if (cfg?.keyId && cfg?.apiToken) {
      try {
        const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(cfg.keyId)}/credentials/generate-ice-servers`, {
          method: 'POST', headers: { Authorization: `Bearer ${cfg.apiToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ttl: 86400 }), signal: AbortSignal.timeout(8000) });
        if (r.ok) {
          const d = await r.json();
          if (Array.isArray(d.iceServers) && d.iceServers.length) { value = { iceServers: d.iceServers, relay: true }; ttl = 3600e3; }
        } else log(`calls: relay credentials refused (${r.status})`);
      } catch (e) { log(`calls: relay credentials: ${e.message}`); }
    } else if (cfg?.metered?.app && cfg.metered.apiKey) {
      try {
        const r = await fetch(`https://${encodeURIComponent(cfg.metered.app)}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(cfg.metered.apiKey)}`, { signal: AbortSignal.timeout(8000) });
        const d = r.ok ? await r.json() : null;
        if (Array.isArray(d) && d.length) { value = { iceServers: d, relay: true }; ttl = 3600e3; } else log(`calls: metered credentials refused (${r.status})`);
      } catch (e) { log(`calls: metered credentials: ${e.message}`); }
    } else if (Array.isArray(cfg?.iceServers) && cfg.iceServers.length) { value = { iceServers: cfg.iceServers, relay: true }; ttl = 3600e3; }
    iceCache = { until: Date.now() + ttl, value };
    return value;
  }

  // ----- ending a call: tell both, leave a line in the chat -----
  function finish(c, reason) {
    if (c.state === 'over') return;
    clearTimeout(c.timer); clearTimeout(c.ping); clearTimeout(c.cap);
    c.state = 'over'; calls.delete(c.id); busy.delete(c.from); busy.delete(c.to);
    emit(c.from, 'call', { type: 'ended', id: c.id, reason });
    emit(c.to, 'call', { type: 'ended', id: c.id, reason });
    const secs = c.answered ? Math.round((Date.now() - c.answered) / 1000) : 0;
    const caller = first(c.from), callee = first(c.to);
    const text = c.answered ? `${caller} and ${callee} · ${mmss(secs)}`
      : reason === 'missed' ? `Missed call from ${caller}` : reason === 'declined' ? `${callee} declined the call` : `${caller} cancelled the call`;
    const missed = reason === 'missed';
    postMessage(c.conv, botId(), { kind: 'card', text, extra: { title: 'Video call', call: true } },
      { pushOnly: missed ? [c.to] : [], pushAs: missed ? { title: `Missed call from ${caller}`, body: 'Open the chat to call back' } : null })
      .catch((e) => log('calls log', e.message));
  }

  async function route(req, res, path, query, me) {
    const M = req.method;
    let m;
    if (M === 'GET' && path === '/api/calls/ice') return send(res, 200, await iceServers()), true;
    if (M === 'POST' && path === '/api/calls/log') {                  // what went wrong on a phone during a call, so it can be fixed
      const b = await readJson(req, 1500);
      const now = Date.now(), r = (logRate.get(me.id) || []).filter((t) => now - t < 60e3);
      r.push(now); logRate.set(me.id, r);
      if (r.length <= 20) log(`calls: ${first(me.id)} saw: ${String(b.msg || '').replace(/\s+/g, ' ').slice(0, 240)}${b.ctx ? ` [${String(b.ctx).slice(0, 120)}]` : ''}`);
      return send(res, 200, { ok: true }), true;
    }
    if (M === 'GET' && path === '/api/calls/state') {                  // the app was just opened: is someone ringing me?
      const c = calls.get(busy.get(me.id));
      return send(res, 200, { call: c ? view(c, me.id) : null }), true;
    }
    if (M === 'POST' && (m = /^\/api\/convs\/(\d+)\/call$/.exec(path))) {
      const convId = Number(m[1]);
      if (!canSee(me, convId)) throw err(404, 'Not found.');
      const conv = one('SELECT * FROM convs WHERE id = ?', convId);
      const others = all("SELECT u.id FROM members mb JOIN users u ON u.id = mb.user_id WHERE mb.conv_id = ? AND u.role != 'bot' AND u.id != ?", convId, me.id);
      if (conv.kind !== 'dm' || others.length !== 1) throw err(400, 'Video calls are one to one: open your chat with them.');
      const to = others[0].id;
      if (busy.has(me.id)) throw err(409, 'You are already in a call.');
      if (busy.has(to)) throw err(409, `${first(to)} is on another call.`);
      const id = randomBytes(8).toString('hex');
      const c = { id, conv: convId, from: me.id, to, state: 'ringing', created: Date.now(), answered: 0 };
      calls.set(id, c); busy.set(me.id, id); busy.set(to, id);
      c.timer = setTimeout(() => finish(c, 'missed'), RING_MS);
      emit(to, 'call', { type: 'incoming', id, conv: convId, from: { id: me.id, name: me.name } });
      // If the app isn't open, nudge the phone a few times (each replaces the last).
      const ping = (n) => {
        if (c.state !== 'ringing') return;
        if (!isActive(to)) notify(to, { title: `${first(me.id)} is calling`, body: 'Tap to answer the video call', url: `/c/${convId}`, tag: `call-${id}` });
        if (n < 4) c.ping = setTimeout(() => ping(n + 1), 10e3);
      };
      ping(0);
      return send(res, 200, { call: { id, conv: convId, to, role: 'caller' } }), true;
    }
    if (M === 'POST' && (m = /^\/api\/calls\/([a-f0-9]{16})\/(accept|decline|end|signal)$/.exec(path))) {
      const c = calls.get(m[1]);
      if (!c || (c.from !== me.id && c.to !== me.id)) throw err(404, 'This call is over.');
      const other = peerOf(c, me.id);
      if (m[2] === 'accept') {
        if (c.to !== me.id || c.state !== 'ringing') throw err(409, 'This call is no longer ringing.');
        c.state = 'active'; c.answered = Date.now();
        clearTimeout(c.timer); clearTimeout(c.ping);
        c.cap = setTimeout(() => finish(c, 'ended'), MAX_CALL_MS);
        emit(c.from, 'call', { type: 'accepted', id: c.id });
        return send(res, 200, { ok: true }), true;
      }
      if (m[2] === 'decline') {
        if (c.to !== me.id || c.state !== 'ringing') throw err(409, 'This call is no longer ringing.');
        finish(c, 'declined');
        return send(res, 200, { ok: true }), true;
      }
      if (m[2] === 'end') {
        const why = String((await readJson(req, 400).catch(() => ({}))).why || 'hangup').slice(0, 40);
        log(`calls: ${c.id} ended by ${first(me.id)} (${why}) after ${c.answered ? Math.round((Date.now() - c.answered) / 1000) : 0}s`);
        finish(c, c.state === 'ringing' ? (me.id === c.from ? 'cancelled' : 'declined') : 'ended');
        return send(res, 200, { ok: true }), true;
      }
      // signal: connection offer / answer / network candidate, passed on to the other person unchanged
      if (c.state !== 'active') throw err(409, 'The call has not started.');
      const b = (await readJson(req, 20_000)).data;
      const ok = b && typeof b === 'object' && (
        (b.sdp && ['offer', 'answer'].includes(b.sdp.type) && typeof b.sdp.sdp === 'string' && b.sdp.sdp.length < 16000) ||
        (b.candidate && typeof b.candidate.candidate === 'string' && b.candidate.candidate.length < 800) ||
        b.candidate === null);
      if (!ok) throw err(400, 'Bad signal.');
      const clean = b.sdp ? { sdp: { type: b.sdp.type, sdp: b.sdp.sdp } }
        : b.candidate ? { candidate: { candidate: b.candidate.candidate, sdpMid: b.candidate.sdpMid ?? null, sdpMLineIndex: Number.isInteger(b.candidate.sdpMLineIndex) ? b.candidate.sdpMLineIndex : null } }
        : { candidate: null };
      emit(other, 'call', { type: 'signal', id: c.id, data: clean });
      return send(res, 200, { ok: true }), true;
    }
    return false;
  }

  // Guman's check from his S20 chat: is the relay set up?
  async function command(text) {
    if (!/^call\s+status$/i.test(String(text).trim())) return null;
    iceCache = null;
    const v = await iceServers();
    return v.relay
      ? '📹 Video calls: ready. The relay is on, so calls work between different networks (her mobile data and your home WiFi).'
      : '📹 Video calls: direct only. They work when both phones can reach each other (same WiFi, many networks) but can fail across different networks. ' +
        (readCfg() ? 'A relay key is saved but the provider did not accept it; check the details.' : 'Add a relay key (set-relay.sh) to switch the relay on.');
  }

  return { route, command, iceServers, activeCount: () => calls.size };
}
