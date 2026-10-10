// Cupboard web app. One page; the path picks the screen. Messages and names are always inserted as text.
const app = document.getElementById('app');

// ---------- helpers ----------
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}
let toastT;
function toast(msg, bad = false) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'toast' + (bad ? ' bad' : ''); t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 2600);
}
async function api(path, { method = 'GET', body, raw, headers = {} } = {}) {
  const opts = { method, credentials: 'same-origin', headers: { ...headers } };
  if (method !== 'GET') opts.headers['X-Cup'] = '1';
  if (raw) opts.body = raw;
  else if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  let r;
  try { r = await fetch('/api' + path, opts); }
  catch { await new Promise((ok) => setTimeout(ok, 1200)); try { r = await fetch('/api' + path, opts); } catch { throw new Error('Could not reach your S20. Check your connection.'); } }
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && !path.startsWith('/login') && !path.startsWith('/invite') && path !== '/me') { state.me = null; go('/login'); throw new Error('Sign in again.'); }
  if (!r.ok || data.error) throw new Error(data.error || `Error ${r.status}`);
  return data;
}
const initials = (name) => (name || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
const kind = (id) => 'k' + ((id || 0) % 4);
function avatar(conv, small) {
  if (conv.kind === 'bot') return h('div', { class: 'av bot' + (small ? ' sm' : '') }, 'S20');
  const other = conv.people?.find((p) => p.id !== state.me.id);
  return h('div', { class: `av ${conv.kind === 'group' ? 'k3' : kind(other?.id)}${small ? ' sm' : ''}` }, initials(conv.title));
}
const time = (t) => new Date(t).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
function when(t) {
  const d = new Date(t), now = new Date();
  if (d.toDateString() === now.toDateString()) return time(t);
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-IN', now - d < 6 * 86400e3 ? { weekday: 'short' } : { day: 'numeric', month: 'short' });
}
const dayLabel = (t) => { const w = when(t); return /\d:\d/.test(w) ? 'Today' : w; };
const preview = (m) => !m ? '' : m.kind === 'voice' ? '🎤 Voice note' : (m.extra?.title ? `${m.extra.title}: ` : '') + (m.text || '');
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// ---------- state ----------
const state = { me: null, vapid: null, push: false, convs: [], users: [], cur: null, msgs: [], more: false, replyTo: null, typing: {} };
const convById = (id) => state.convs.find((c) => c.id === id);
function upsertConv(c) {
  const i = state.convs.findIndex((x) => x.id === c.id);
  if (i >= 0) state.convs[i] = c; else state.convs.push(c);
  state.convs.sort((a, b) => (b.last?.at || b.created) - (a.last?.at || a.created));
}

// ---------- live updates ----------
let es = null;
function connect() {
  es?.close();
  es = new EventSource('/api/stream');
  es.addEventListener('msg', (e) => {
    const { msg, conv } = JSON.parse(e.data);
    upsertConv(conv);
    if (state.cur?.id === msg.conv) {
      if (!state.msgs.some((m) => m.id === msg.id)) { state.msgs.push(msg); drawMessages(true); markRead(); }
      delete state.typing[msg.conv]; drawHeader();
    } else if (route().name === 'list') drawList();
  });
  es.addEventListener('update', (e) => {
    const { msg } = JSON.parse(e.data);
    const i = state.msgs.findIndex((m) => m.id === msg.id);
    if (i >= 0) { state.msgs[i] = msg; drawMessages(false); }
  });
  es.addEventListener('read', (e) => {
    const { conv, user, upTo } = JSON.parse(e.data);
    const c = convById(conv); const p = c?.people.find((x) => x.id === user);
    if (p) p.lastRead = Math.max(p.lastRead || 0, upTo);
    if (state.cur?.id === conv) { state.cur = c || state.cur; drawMessages(false); }
    if (user === state.me.id && c) { c.unread = 0; if (route().name === 'list') drawList(); }
  });
  es.addEventListener('typing', (e) => {
    const { conv, name } = JSON.parse(e.data);
    state.typing[conv] = { name, until: Date.now() + 4000 };
    if (state.cur?.id === conv) { drawHeader(); drawMessages(true, true); setTimeout(() => { if ((state.typing[conv]?.until || 0) <= Date.now()) { delete state.typing[conv]; drawHeader(); drawMessages(false); } }, 4100); }
  });
}
// Tell the server we're looking, so it doesn't send pushes for chats we can already see.
let presenceT;
function presence() {
  clearInterval(presenceT);
  const ping = () => { if (state.me) api('/presence', { method: 'POST', body: { visible: document.visibilityState === 'visible' } }).catch(() => {}); };
  ping(); presenceT = setInterval(ping, 20e3);
}
document.addEventListener('visibilitychange', async () => {
  if (!state.me) return;
  presence();
  if (document.visibilityState === 'visible') { await loadConvs().catch(() => {}); if (state.cur) await openConv(state.cur.id, true).catch(() => {}); else if (route().name === 'list') drawList(); }
});

// ---------- push notifications ----------
const b64 = (s) => { const p = '='.repeat((4 - (s.length % 4)) % 4); const r = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from([...r].map((c) => c.charCodeAt(0))); };
async function enablePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error(isIOS() && !isStandalone() ? 'First add Cupboard to your Home Screen, then open it from there.' : 'This browser does not support notifications.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Notifications are blocked. Allow them in Settings → Notifications → Cupboard.');
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(state.vapid) });
  await api('/push', { method: 'POST', body: { subscription: sub.toJSON() } });
  state.push = true;
}
async function disablePush() {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) { await api('/push', { method: 'DELETE', body: { endpoint: sub.endpoint } }).catch(() => {}); await sub.unsubscribe(); }
  state.push = false;
}
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('message', (e) => { if (e.data?.nav) go(e.data.nav); });
}

// ---------- data ----------
async function loadConvs() { state.convs = (await api('/convs')).convs; }
async function openConv(id, refresh) {
  const [{ conv }, { messages, more }] = await Promise.all([api(`/convs/${id}`), api(`/convs/${id}/messages`)]);
  state.cur = conv; state.msgs = messages; state.more = more; upsertConv(conv);
  if (!refresh) state.replyTo = null;
  drawMessages(true); drawHeader(); markRead();
}
let readT;
function markRead() {
  clearTimeout(readT);
  readT = setTimeout(() => {
    const last = state.msgs[state.msgs.length - 1];
    if (!state.cur || !last || document.visibilityState !== 'visible') return;
    api(`/convs/${state.cur.id}/read`, { method: 'POST', body: { upTo: last.id } }).catch(() => {});
    const c = convById(state.cur.id); if (c) c.unread = 0;
  }, 300);
}

// ---------- router ----------
function route() {
  const p = location.pathname;
  let m;
  if ((m = /^\/c\/(\d+)$/.exec(p))) return { name: 'chat', id: Number(m[1]) };
  if ((m = /^\/invite\/([a-f0-9]{32})$/.exec(p))) return { name: 'invite', token: m[1] };
  return { name: { '/login': 'login', '/new': 'new', '/group': 'group', '/me': 'me' }[p] || 'list' };
}
function go(path, replace) { if (location.pathname !== path) history[replace ? 'replaceState' : 'pushState'](null, '', path); render(); }
window.addEventListener('popstate', render);
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (a && !e.metaKey && !e.ctrlKey) { e.preventDefault(); go(a.getAttribute('href')); }
});

async function render() {
  const r = route();
  state.cur = r.name === 'chat' ? state.cur : null;
  if (r.name === 'invite') return screens.invite(r.token);
  if (!state.me) {
    const me = await api('/me').catch(() => ({}));
    state.vapid = me.vapid; state.push = me.push;
    if (!me.user) return screens.login();
    state.me = me.user; connect(); presence(); await loadConvs().catch(() => {});
  }
  if (r.name === 'login') return go('/', true);
  try { await screens[r.name](r); } catch (e) { app.replaceChildren(h('p', { class: 'loading' }, e.message)); }
}

// ---------- screens ----------
const screens = {
  login() {
    const u = h('input', { autocomplete: 'username', autocapitalize: 'none', autocorrect: 'off', required: true });
    const p = h('input', { type: 'password', autocomplete: 'current-password', required: true });
    const err = h('p', { class: 'err' });
    const b = h('button', { class: 'btn full', type: 'submit' }, 'Sign in');
    const f = h('form', {}, h('label', { class: 'field' }, h('span', {}, 'Username'), u), h('label', { class: 'field' }, h('span', {}, 'Password'), p), b, err);
    f.addEventListener('submit', async (e) => {
      e.preventDefault(); b.disabled = true; err.textContent = '';
      try { await api('/login', { method: 'POST', body: { username: u.value, password: p.value } }); state.me = null; go('/', true); }
      catch (x) { err.textContent = x.message; } finally { b.disabled = false; }
    });
    app.replaceChildren(h('div', { class: 'bar' }, h('h1', {}, 'Cupboard')),
      h('div', { class: 'page' }, h('div', { class: 'brandbox' }, h('h2', {}, 'Cupboard'), h('p', { class: 'lede' }, 'Private chat, served from a phone in a cupboard. Invite only.')), f));
  },

  async invite(token) {
    const inv = await api(`/invite/${token}`).catch(() => ({ valid: false }));
    if (!inv.valid) {
      app.replaceChildren(h('div', { class: 'bar' }, h('h1', {}, 'Cupboard')), h('div', { class: 'page' }, h('h2', {}, 'Invite expired'),
        h('p', { class: 'lede' }, 'This link was already used or is older than 7 days. Ask for a new one.'), h('a', { class: 'btn ghost', href: '/login', 'data-link': true }, 'Sign in instead')));
      return;
    }
    const name = h('input', { autocomplete: 'name', required: true, maxlength: '40' });
    const user = h('input', { autocomplete: 'username', autocapitalize: 'none', autocorrect: 'off', required: true, maxlength: '20', placeholder: 'e.g. rahul_k' });
    const pass = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: '8' });
    const err = h('p', { class: 'err' });
    const b = h('button', { class: 'btn full', type: 'submit' }, inv.owner ? 'Create my account' : 'Join Cupboard');
    const f = h('form', {}, h('label', { class: 'field' }, h('span', {}, 'Your name'), name), h('label', { class: 'field' }, h('span', {}, 'Username (to sign in)'), user),
      h('label', { class: 'field' }, h('span', {}, 'Password (at least 8 characters)'), pass), b, err);
    f.addEventListener('submit', async (e) => {
      e.preventDefault(); b.disabled = true; err.textContent = '';
      try { await api(`/invite/${token}`, { method: 'POST', body: { name: name.value, username: user.value, password: pass.value } }); state.me = null; go('/', true); }
      catch (x) { err.textContent = x.message; } finally { b.disabled = false; }
    });
    app.replaceChildren(h('div', { class: 'bar' }, h('h1', {}, 'Cupboard')),
      h('div', { class: 'page' }, h('div', { class: 'brandbox' }, h('h2', {}, inv.owner ? 'Your Cupboard' : `${inv.by} invited you`),
        h('p', { class: 'lede' }, inv.owner ? 'Set up the owner account for your phone server.' : 'Cupboard is a private chat that runs on Guman\'s phone server. Messages are stored on that phone (not end-to-end encrypted).')), f));
  },

  list() {
    app.replaceChildren(
      h('div', { class: 'bar' }, h('div', { class: 't' }, h('h1', {}, 'Cupboard'), h('small', { id: 'phone' }, 'served from an S20')),
        h('a', { class: 'icon', href: '/new', 'data-link': true, 'aria-label': 'New chat', title: 'New chat' }, '✎'),
        h('a', { class: 'icon', href: '/me', 'data-link': true, 'aria-label': 'Settings', title: 'Settings' }, '⚙')),
      h('div', { class: 'scroll', id: 'list' }));
    drawList();
    api('/status').then((s) => { const el = document.getElementById('phone'); if (el && s.battery != null) el.textContent = `served from an S20 · 🔋${s.battery}% · ${Math.round(s.tempC)}°C`; }).catch(() => {});
  },

  async chat(r) {
    app.replaceChildren(
      h('div', { class: 'bar', id: 'chatbar' }),
      h('div', { class: 'msgs', id: 'msgs' }, h('p', { class: 'loading' }, 'Loading…')),
      h('div', { id: 'composer' }));
    await openConv(r.id);
    drawComposer();
  },

  async new() {
    state.users = (await api('/users')).users;
    const owner = state.me.role === 'owner';
    const invite = h('div', {});
    const mk = h('button', { class: 'btn', type: 'button' }, 'Create invite link');
    mk.addEventListener('click', async () => {
      mk.disabled = true;
      try {
        const { path } = await api('/invites', { method: 'POST' });
        const url = location.origin + path;
        const copy = h('button', { class: 'btn ghost', type: 'button' }, 'Copy');
        copy.addEventListener('click', async () => { await navigator.clipboard.writeText(url); toast('Copied'); });
        const share = navigator.share ? h('button', { class: 'btn', type: 'button' }, 'Share…') : null;
        share?.addEventListener('click', () => navigator.share({ title: 'Join me on Cupboard', text: 'My private chat app, running on my phone server:', url }).catch(() => {}));
        invite.replaceChildren(h('p', { class: 'lede' }, 'Send this to one friend. It works once and expires in 7 days.'), h('div', { class: 'link' }, url), h('div', { style: 'display:flex;gap:.5rem' }, share, copy));
      } catch (e) { toast(e.message, true); } finally { mk.disabled = false; }
    });
    app.replaceChildren(
      h('div', { class: 'bar' }, h('a', { class: 'icon back', href: '/', 'data-link': true, 'aria-label': 'Back' }, '‹'), h('div', { class: 't' }, h('b', {}, 'New chat'))),
      h('div', { class: 'scroll' },
        h('a', { class: 'row', href: '/group', 'data-link': true }, h('div', { class: 'av k3' }, '+'), h('div', { class: 'mid' }, h('div', { class: 'name' }, 'New group'), h('div', { class: 'prev' }, h('span', {}, 'Chat with several friends')))),
        ...state.users.map((u) => {
          const b = h('button', { class: 'row', type: 'button' }, h('div', { class: `av ${kind(u.id)}` }, initials(u.name)), h('div', { class: 'mid' }, h('div', { class: 'name' }, u.name), h('div', { class: 'prev' }, h('span', {}, '@' + u.username))));
          b.addEventListener('click', async () => { const { conv } = await api('/convs', { method: 'POST', body: { members: [u.id] } }); upsertConv(conv); go(`/c/${conv.id}`); });
          return b;
        }),
        !state.users.length ? h('p', { class: 'empty' }, owner ? 'No friends yet. Invite someone below.' : 'Nobody else here yet.') : null,
        owner ? h('div', { class: 'page', style: 'flex:none' }, h('div', { class: 'sec' }, 'Invite a friend'), invite, mk) : null));
  },

  async group() {
    state.users = (await api('/users')).users;
    const name = h('input', { maxlength: '40', required: true, placeholder: 'e.g. Weekend crew' });
    const picks = state.users.map((u) => ({ u, box: h('input', { type: 'checkbox', value: String(u.id) }) }));
    const err = h('p', { class: 'err' });
    const b = h('button', { class: 'btn full', type: 'submit' }, 'Create group');
    const f = h('form', {}, h('label', { class: 'field' }, h('span', {}, 'Group name'), name), h('div', { class: 'sec' }, 'Members'),
      ...picks.map(({ u, box }) => h('label', { class: 'check' }, box, h('div', { class: `av sm ${kind(u.id)}` }, initials(u.name)), u.name)),
      !picks.length ? h('p', { class: 'lede' }, 'Invite friends first.') : null, h('div', { style: 'margin-top:1rem' }, b), err);
    f.addEventListener('submit', async (e) => {
      e.preventDefault(); b.disabled = true; err.textContent = '';
      try {
        const { conv } = await api('/convs', { method: 'POST', body: { name: name.value, members: picks.filter((p) => p.box.checked).map((p) => p.u.id) } });
        upsertConv(conv); go(`/c/${conv.id}`, true);
      } catch (x) { err.textContent = x.message; } finally { b.disabled = false; }
    });
    app.replaceChildren(h('div', { class: 'bar' }, h('a', { class: 'icon back', href: '/new', 'data-link': true, 'aria-label': 'Back' }, '‹'), h('div', { class: 't' }, h('b', {}, 'New group'))), h('div', { class: 'page' }, f));
  },

  async me() {
    const owner = state.me.role === 'owner';
    const notif = h('button', { class: 'btn', type: 'button' }, state.push ? 'Turn off on this device' : 'Turn on notifications');
    notif.addEventListener('click', async () => {
      notif.disabled = true;
      try { if (state.push) { await disablePush(); toast('Notifications off'); } else { await enablePush(); toast('Notifications on'); } render(); }
      catch (e) { toast(e.message, true); } finally { notif.disabled = false; }
    });
    const out = h('button', { class: 'btn ghost', type: 'button' }, 'Sign out');
    out.addEventListener('click', async () => { await api('/logout', { method: 'POST' }).catch(() => {}); es?.close(); state.me = null; go('/login', true); });
    let people = [];
    if (owner) {
      state.users = (await api('/users')).users;
      people = state.users.map((u) => {
        const x = h('button', { class: 'x', type: 'button' }, 'Remove');
        x.addEventListener('click', async () => { if (!confirm(`Remove ${u.name} from Cupboard? They'll be signed out and can't come back without a new invite.`)) return; await api(`/users/${u.id}`, { method: 'DELETE' }); toast('Removed'); render(); });
        return h('div', { class: 'kv' }, h('span', {}, `${u.name} · @${u.username}`), x);
      });
    }
    app.replaceChildren(
      h('div', { class: 'bar' }, h('a', { class: 'icon back', href: '/', 'data-link': true, 'aria-label': 'Back' }, '‹'), h('div', { class: 't' }, h('b', {}, 'Settings'))),
      h('div', { class: 'page' },
        h('h2', {}, state.me.name), h('p', { class: 'lede' }, '@' + state.me.username + (owner ? ' · owner' : '')),
        h('div', { class: 'sec' }, 'Notifications'),
        !isStandalone() && isIOS() ? h('p', { class: 'lede' }, 'On iPhone, notifications work once Cupboard is on your Home Screen: Safari → Share → Add to Home Screen, then open it from there.') : null,
        notif,
        !isStandalone() ? h('div', {}, h('div', { class: 'sec' }, 'Install'), h('p', { class: 'lede' }, isIOS() ? 'Safari → Share (□↑) → Add to Home Screen.' : 'Browser menu → Install app / Add to Home screen.')) : null,
        owner ? h('div', {}, h('div', { class: 'sec' }, 'People'), ...(people.length ? people : [h('p', { class: 'lede' }, 'Nobody yet. Invite friends from ✎ → Invite a friend.')])) : null,
        h('div', { class: 'sec' }, 'Privacy'),
        h('p', { class: 'lede' }, 'Messages and voice notes are stored on Guman\'s S20 phone server. They are not end-to-end encrypted.'),
        h('div', { style: 'margin-top:1.5rem' }, out)));
  },
};

// ---------- drawing ----------
function drawList() {
  const list = document.getElementById('list');
  if (!list) return;
  const banners = [];
  if (isIOS() && !isStandalone()) banners.push(h('div', { class: 'banner' }, h('b', {}, 'Install Cupboard'), 'Tap Share (□↑) → Add to Home Screen. Then open it from your Home Screen to get notifications.'));
  else if (isStandalone() && !state.push && 'Notification' in window && Notification.permission !== 'denied') {
    const b = h('button', { class: 'btn', type: 'button' }, 'Turn on notifications');
    b.addEventListener('click', async () => { try { await enablePush(); toast('Notifications on'); drawList(); } catch (e) { toast(e.message, true); } });
    banners.push(h('div', { class: 'banner' }, h('b', {}, 'Get notified'), 'So the S20 and your friends can reach you.', h('div', {}, b)));
  }
  list.replaceChildren(...banners, ...(state.convs.length ? state.convs.map((c) =>
    h('a', { class: 'row', href: `/c/${c.id}`, 'data-link': true }, avatar(c),
      h('div', { class: 'mid' },
        h('div', { class: 'name' }, h('span', {}, c.title), h('small', {}, c.last ? when(c.last.at) : '')),
        h('div', { class: 'prev' }, h('span', {}, (c.last && c.kind === 'group' && c.last.from !== state.me.id ? `${c.people.find((p) => p.id === c.last.from)?.name?.split(' ')[0] || ''}: ` : '') + preview(c.last)),
          c.unread ? h('span', { class: 'badge' }, String(c.unread)) : null)))) : [h('p', { class: 'empty' }, 'No chats yet.')]));
}

function drawHeader() {
  const bar = document.getElementById('chatbar');
  const c = state.cur;
  if (!bar || !c) return;
  const t = state.typing[c.id];
  const sub = t && t.until > Date.now() ? h('small', { class: 'typing' }, c.kind === 'group' ? `${t.name} is typing…` : 'typing…')
    : h('small', {}, c.kind === 'bot' ? 'your phone server' : c.kind === 'group' ? c.people.map((p) => (p.id === state.me.id ? 'you' : p.name.split(' ')[0])).join(', ') : '@' + (c.people.find((p) => p.id !== state.me.id)?.username || ''));
  bar.replaceChildren(h('a', { class: 'icon back', href: '/', 'data-link': true, 'aria-label': 'Back' }, '‹'), avatar(c, true), h('div', { class: 't' }, h('b', {}, c.title), sub));
}

let player = null, playing = null;
function voiceBubble(m) {
  const bars = (m.extra?.peaks?.length ? m.extra.peaks : Array.from({ length: 24 }, (_, i) => 3 + ((i * 7) % 6))).slice(0, 32);
  const wave = h('span', { class: 'wave' }, bars.map((v) => h('i', { style: `height:${15 + v * 9.4}%` })));
  const btn = h('button', { class: 'play', type: 'button', 'aria-label': 'Play voice note' }, '▶');
  const len = h('small', {}, mmss(m.duration || 0));
  const paint = () => {
    const on = playing === m.id && player;
    btn.textContent = on && !player.paused ? '❚❚' : '▶';
    const frac = on && player.duration ? player.currentTime / player.duration : 0;
    [...wave.children].forEach((b, i) => b.classList.toggle('on', i / wave.children.length < frac));
    len.textContent = on && player.currentTime ? mmss(player.currentTime) : mmss(m.duration || 0);
  };
  btn.addEventListener('click', () => {
    if (playing === m.id && player) { player.paused ? player.play() : player.pause(); return; }
    player?.pause();
    player = new Audio(m.media); playing = m.id;
    player.addEventListener('timeupdate', paint); player.addEventListener('pause', paint); player.addEventListener('play', paint);
    player.addEventListener('ended', () => { playing = null; paint(); });
    player.play().catch(() => toast('Could not play this voice note.', true));
  });
  return h('div', { class: 'voice' }, btn, wave, len);
}

function bubble(m, prev) {
  const c = state.cur, mine = m.from === state.me.id;
  const who = c.people.find((p) => p.id === m.from);
  if (m.kind === 'text' && /^👋 .+ joined Cupboard$|created ".+"$/.test(m.text || '') && !m.extra) return h('div', { class: 'sys' }, m.text);
  const others = c.people.filter((p) => p.id !== state.me.id && p.role !== 'bot');
  const read = mine && others.length && others.every((p) => (p.lastRead || 0) >= m.id);
  const meta = h('span', { class: 'meta' }, time(m.at), mine ? ' ' : '', mine ? h('span', { class: read ? 'read' : '' }, read ? '✓✓' : '✓') : null);
  const kids = [];
  if (c.kind === 'group' && !mine && who && prev?.from !== m.from) kids.push(h('span', { class: 'who' }, who.name));
  if (m.extra?.replyTo) { const q = state.msgs.find((x) => x.id === m.extra.replyTo); if (q) kids.push(h('span', { class: 'quote' }, preview(q))); }
  if (m.kind === 'voice') kids.push(voiceBubble(m));
  else if (m.kind === 'card') {
    if (m.extra?.title) kids.push(h('span', { class: 'h' }, m.extra.title));
    kids.push(m.text || '');
    if (m.extra?.done) kids.push(h('div', {}, h('span', { class: 'done' }, '✓ ' + m.extra.done)));
    else {
      const acts = (m.extra?.actions || []).map((a) => {
        const b = h('button', { type: 'button', class: a.style === 'go' ? 'go' : '' }, a.label);
        b.addEventListener('click', async () => { b.disabled = true; try { await api(`/messages/${m.id}/action`, { method: 'POST', body: { action: a.id } }); } catch (e) { toast(e.message, true); b.disabled = false; } });
        return b;
      });
      if (m.extra?.replyTo) { const r = h('button', { type: 'button' }, '↩ Reply'); r.addEventListener('click', () => { state.replyTo = m; drawComposer(); document.querySelector('.compose textarea')?.focus(); }); acts.push(r); }
      if (acts.length) kids.push(h('div', { class: 'acts' }, acts));
    }
  } else kids.push(m.text || '');
  kids.push(meta);
  return h('div', { class: `m ${mine ? 'out' : 'in'}${m.kind === 'card' ? ' card' : ''}` }, kids);
}

function drawMessages(stick, typingOnly) {
  const box = document.getElementById('msgs');
  if (!box || !state.cur) return;
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const nodes = [];
  if (state.more) {
    const b = h('button', { class: 'more', type: 'button' }, 'Load earlier messages');
    b.addEventListener('click', async () => {
      const { messages, more } = await api(`/convs/${state.cur.id}/messages?before=${state.msgs[0].id}`);
      const h0 = box.scrollHeight; state.msgs = [...messages, ...state.msgs]; state.more = more; drawMessages(false); box.scrollTop = box.scrollHeight - h0;
    });
    nodes.push(b);
  }
  let lastDay = null, prev = null;
  for (const m of state.msgs) {
    const d = dayLabel(m.at);
    if (d !== lastDay) { nodes.push(h('div', { class: 'day' }, d)); lastDay = d; prev = null; }
    nodes.push(bubble(m, prev)); prev = m;
  }
  if (!state.msgs.length) nodes.push(h('p', { class: 'empty' }, state.cur.kind === 'bot' ? 'Type "help" to see what your S20 can do.' : 'Say hi 👋'));
  const t = state.typing[state.cur.id];
  if (t && t.until > Date.now()) nodes.push(h('div', { class: 'typing-dots', 'aria-label': `${t.name} is typing` }, h('i'), h('i'), h('i')));
  box.replaceChildren(...nodes);
  if (stick || atBottom || typingOnly && atBottom) box.scrollTop = box.scrollHeight;
}

// ---------- composer: text, quick commands, voice notes ----------
let rec = null;
function drawComposer() {
  const wrap = document.getElementById('composer');
  if (!wrap || !state.cur) return;
  const c = state.cur;
  const parts = [];
  if (c.kind === 'bot') parts.push(h('div', { class: 'chips' }, ['status', 'room', 'arm', 'disarm', 'spent today', 'spent month', 'help'].map((cmd) => {
    const b = h('button', { type: 'button' }, cmd); b.addEventListener('click', () => sendText(cmd)); return b;
  })));
  if (state.replyTo) {
    const x = h('button', { class: 'icon', type: 'button', 'aria-label': 'Cancel reply' }, '✕');
    x.addEventListener('click', () => { state.replyTo = null; drawComposer(); });
    parts.push(h('div', { class: 'replying' }, h('span', {}, 'Replying to: ' + preview(state.replyTo)), x));
  }
  if (rec) {
    const cancel = h('button', { class: 'icon', type: 'button', 'aria-label': 'Cancel recording' }, '✕');
    const send = h('button', { class: 'send', type: 'button', 'aria-label': 'Send voice note' }, '➤');
    cancel.addEventListener('click', () => stopRec(false));
    send.addEventListener('click', () => stopRec(true));
    parts.push(h('div', { class: 'compose' }, cancel, h('div', { class: 'rec' }, h('i'), h('span', { id: 'rect' }, '0:00'), h('div', { class: 'lvl' }, h('b', { id: 'recl' }))), send));
  } else {
    const ta = h('textarea', { rows: '1', placeholder: c.kind === 'bot' ? 'Message S20…' : 'Message', enterkeyhint: 'send', 'aria-label': 'Message' });
    const btn = h('button', { class: 'send', type: 'button', 'aria-label': 'Record a voice note' }, '🎤');
    let lastTyping = 0;
    const sync = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 128) + 'px'; const has = !!ta.value.trim(); btn.textContent = has ? '➤' : '🎤'; btn.setAttribute('aria-label', has ? 'Send' : 'Record a voice note'); };
    ta.addEventListener('input', () => {
      sync();
      if (c.kind !== 'bot' && Date.now() - lastTyping > 3000 && ta.value.trim()) { lastTyping = Date.now(); api(`/convs/${c.id}/typing`, { method: 'POST' }).catch(() => {}); }
    });
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !isIOS()) { e.preventDefault(); if (ta.value.trim()) { sendText(ta.value); ta.value = ''; sync(); } } });
    btn.addEventListener('click', () => { if (ta.value.trim()) { sendText(ta.value); ta.value = ''; sync(); ta.focus(); } else startRec(); });
    parts.push(h('div', { class: 'compose' }, ta, btn));
  }
  wrap.replaceChildren(...parts);
}

async function sendText(text) {
  const t = text.trim(); if (!t || !state.cur) return;
  const replyTo = state.replyTo?.id || null;
  state.replyTo = null; drawComposer();
  try { await api(`/convs/${state.cur.id}/messages`, { method: 'POST', body: { text: t, replyTo } }); }
  catch (e) { toast(e.message, true); }
}

async function startRec() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return toast('Voice notes are not supported in this browser.', true);
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = ['audio/mp4', 'audio/aac', 'audio/webm;codecs=opus', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
    const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
    const chunks = [];
    mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const an = ac.createAnalyser(); an.fftSize = 512; ac.createMediaStreamSource(stream).connect(an);
    const buf = new Uint8Array(an.fftSize), levels = [];
    rec = { mr, stream, ac, chunks, levels, t0: Date.now(), mime: mr.mimeType || mime };
    drawComposer();
    rec.tick = setInterval(() => {
      an.getByteTimeDomainData(buf);
      let s = 0; for (const v of buf) s += ((v - 128) / 128) ** 2;
      const lvl = Math.min(1, Math.sqrt(s / buf.length) * 4);
      levels.push(lvl);
      const secs = (Date.now() - rec.t0) / 1000;
      const t = document.getElementById('rect'), l = document.getElementById('recl');
      if (t) t.textContent = mmss(secs);
      if (l) l.style.width = Math.round(lvl * 100) + '%';
      if (secs >= 120) stopRec(true);
    }, 100);
    mr.start(250);
  } catch { rec = null; drawComposer(); toast('Microphone permission is needed for voice notes.', true); }
}
function stopRec(send) {
  const r = rec; if (!r) return;
  rec = null; clearInterval(r.tick);
  r.mr.onstop = async () => {
    r.stream.getTracks().forEach((t) => t.stop()); r.ac.close().catch(() => {});
    drawComposer();
    const duration = (Date.now() - r.t0) / 1000;
    if (!send || duration < 0.8) { if (send) toast('Too short. Tap and talk a little longer.'); return; }
    const blob = new Blob(r.chunks, { type: (r.mime || 'audio/mp4').split(';')[0] });
    const n = 32, step = Math.max(1, r.levels.length / n);
    const peaks = Array.from({ length: Math.min(n, r.levels.length) }, (_, i) => {
      const slice = r.levels.slice(Math.floor(i * step), Math.floor((i + 1) * step) || undefined);
      return Math.round(Math.max(...slice, 0) * 9);
    });
    try {
      await api(`/convs/${state.cur.id}/voice`, { method: 'POST', raw: blob, headers: { 'Content-Type': blob.type, 'X-Duration': duration.toFixed(1), 'X-Peaks': peaks.join(',') } });
    } catch (e) { toast(e.message, true); }
  };
  r.mr.stop();
}

render();
