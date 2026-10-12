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
const preview = (m) => !m ? '' : m.kind === 'deleted' ? '🚫 Message deleted' : m.kind === 'voice' ? '🎤 Voice note' : m.kind === 'image' ? `📷 ${m.text || 'Photo'}`
  : m.kind === 'video' ? `🎥 ${m.text || 'Video'}` : m.kind === 'file' ? `📄 ${m.extra?.name || 'File'}` : (m.extra?.title ? `${m.extra.title}: ` : '') + (m.text || '');
const REACTIONS = ['❤️', '👍', '😂', '😮', '😢', '🙏'];
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// ---------- state ----------
const state = { me: null, vapid: null, push: false, convs: [], users: [], cur: null, msgs: [], more: false, newer: false, replyTo: null, editing: null, typing: {}, pinIdx: 0 };
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
  es.addEventListener('conv', (e) => {               // mute, archive or pins changed
    const { conv } = JSON.parse(e.data);
    upsertConv(conv);
    if (state.cur?.id === conv.id) { state.cur = conv; drawHeader(); drawPins(); } else if (['list', 'archived'].includes(route().name)) drawList();
  });
  es.addEventListener('read', (e) => {
    const { conv, user, upTo } = JSON.parse(e.data);
    const c = convById(conv); const p = c?.people.find((x) => x.id === user);
    if (p) p.lastRead = Math.max(p.lastRead || 0, upTo);
    if (state.cur?.id === conv) { state.cur = c || state.cur; drawMessages(false); }
    if (user === state.me.id && c) { c.unread = 0; if (route().name === 'list') drawList(); }
  });
  es.addEventListener('list', (e) => { const d = JSON.parse(e.data); if (d.gone) dropList(d.id); else upsertList(d.list); });
  es.addEventListener('event', (e) => { const d = JSON.parse(e.data); if (d.gone) dropEvent(d.id); else upsertEvent(d.event); });
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
  state.cur = conv; state.msgs = messages; state.more = more; state.newer = false; upsertConv(conv);
  if (!refresh) { state.replyTo = null; state.editing = null; state.pinIdx = 0; clearTray(); state.draft = ''; }
  drawMessages(true); drawHeader(); drawPins(); markRead();
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
  if ((m = /^\/c\/(\d+)\/media$/.exec(p))) return { name: 'media', id: Number(m[1]) };
  if ((m = /^\/invite\/([a-f0-9]{32})$/.exec(p))) return { name: 'invite', token: m[1] };
  if ((m = /^\/signin\/([a-f0-9]{32})$/.exec(p))) return { name: 'signin', token: m[1] };
  if ((m = /^\/device\/([a-f0-9]{32})$/.exec(p))) return { name: 'device', token: m[1] };
  if ((m = /^\/jobs(?:\/(jobs|questions|referrals|live))?$/.exec(p))) return { name: 'jobs', tab: m[1] || 'overview' };
  if ((m = /^\/together(\/calendar)?$/.exec(p))) return { name: 'together', tab: m[1] ? 'cal' : 'lists' };
  if ((m = /^\/together\/list\/(\d+)$/.exec(p))) return { name: 'tlist', id: Number(m[1]) };
  return { name: { '/login': 'login', '/new': 'new', '/group': 'group', '/me': 'me', '/search': 'search', '/archived': 'archived' }[p] || 'list' };
}
function go(path, replace) { if (location.pathname + location.search !== path) history[replace ? 'replaceState' : 'pushState'](null, '', path); render(); }
window.addEventListener('popstate', render);
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (a && !e.metaKey && !e.ctrlKey) { e.preventDefault(); go(a.getAttribute('href')); }
});

async function render() {
  const r = route();
  state.cur = r.name === 'chat' ? state.cur : null;
  if (r.name === 'invite') return screens.invite(r.token);
  if (r.name === 'device') return screens.device(r.token);
  if (!state.me) {
    const me = await api('/me').catch(() => ({}));
    if (me.device === false) return screens.untrusted();
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

  // Only trusted devices reach Cupboard. An unknown browser sees this and nothing else.
  untrusted() {
    app.replaceChildren(h('div', { class: 'page' }, h('div', { class: 'brandbox' }, h('h2', {}, 'Not available'),
      h('p', { class: 'lede' }, 'This device isn\'t set up. Open an add-device link from a phone or computer that already uses it.'))));
  },
  // A one-time add-device link (made under Settings → Devices): this browser becomes trusted, then signs in as usual.
  async device(token) {
    const ok = await api(`/device/${token}`).then((r) => r.valid).catch(() => false);
    if (!ok) return app.replaceChildren(h('div', { class: 'page' }, h('div', { class: 'brandbox' }, h('h2', {}, 'Link expired'),
      h('p', { class: 'lede' }, 'Add-device links work once, for 15 minutes. Make a new one in Settings → Devices on a phone or computer that already uses Cupboard.'))));
    const b = h('button', { class: 'btn full', type: 'button' }, 'Trust this device');
    b.addEventListener('click', async () => {
      b.disabled = true;
      try { await api(`/device/${token}`, { method: 'POST' }); state.me = null; go('/login', true); }
      catch (e) { toast(e.message, true); b.disabled = false; }
    });
    app.replaceChildren(h('div', { class: 'bar' }, h('h1', {}, 'Cupboard')), h('div', { class: 'page' }, h('div', { class: 'brandbox' }, h('h2', {}, 'Add this device'),
      h('p', { class: 'lede' }, 'Only trusted phones and computers can open Cupboard. Trust this one, then sign in as usual.')), b));
  },

  // Sign in to LinkedIn/Naukri on the phone's browser: live screen, tap to click, type below. Polls while open.
  async signin(r) {
    const base = `/signin/${r.token}`;
    let info;
    try { info = await api(base); } catch (e) { app.replaceChildren(h('div', { class: 'bar' }, h('h1', {}, 'Sign in')), h('div', { class: 'page' }, h('p', { class: 'lede' }, e.message))); return; }
    const site = { linkedin: 'LinkedIn', naukri: 'Naukri' }[info.site];
    const back = h('a', { class: 'icon', href: '/', 'data-link': true, 'aria-label': 'Back' }, '←');
    const status = h('p', { class: 'lede', id: 'sstatus' }, 'Starting the phone browser…');
    const img = h('img', { class: 'screen', alt: `${site} on the phone's browser`, draggable: 'false' });
    const box = h('input', { type: 'text', autocapitalize: 'none', autocorrect: 'off', autocomplete: 'off', spellcheck: 'false', placeholder: 'Type here, then Send' });
    const show = h('label', { class: 'show' }, h('input', { type: 'checkbox' }), ' hide what I type');
    show.firstChild.addEventListener('change', () => { box.type = show.firstChild.checked ? 'password' : 'text'; });
    const input = (body) => api(`${base}/input`, { method: 'POST', body }).catch((e) => toast(e.message, true));
    const sendBtn = h('button', { class: 'btn', type: 'button' }, 'Send');
    sendBtn.addEventListener('click', () => { if (box.value) { input({ kind: 'type', text: box.value }); box.value = ''; } box.focus(); });
    box.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendBtn.click(); } });
    const keys = ['Enter', 'Tab', 'Backspace'].map((k) => { const b = h('button', { type: 'button', class: 'key' }, k === 'Backspace' ? '⌫' : k); b.addEventListener('click', () => input({ kind: 'key', key: k })); return b; });
    img.addEventListener('click', (e) => {
      const rect = img.getBoundingClientRect();
      input({ kind: 'tap', x: Math.round((e.clientX - rect.left) * (img.naturalWidth / rect.width)), y: Math.round((e.clientY - rect.top) * (img.naturalHeight / rect.height)) });
    });
    app.replaceChildren(h('div', { class: 'bar' }, back, h('div', { class: 't' }, h('h1', {}, `${site} sign-in`), h('small', {}, 'on your job agent\'s phone browser'))),
      h('div', { class: 'scroll signin' }, status, img, h('div', { class: 'srow' }, box, sendBtn), h('div', { class: 'srow' }, ...keys, show),
        h('p', { class: 'note' }, `Tap the screen to click. What you type goes straight into ${site}'s page; your job agent keeps only the signed-in session, never your password.`)));
    await api(`${base}/start`, { method: 'POST' }).catch((e) => toast(e.message, true));
    const tick = async () => {
      if (route().name !== 'signin') return;
      try {
        const s = await api(base);
        status.textContent = s.signedIn ? `✅ Signed in to ${site}. You can close this page.` : s.mine ? 'Your turn: sign in below.' : s.busy ? 'Waiting for the phone browser (it is finishing another task)…' : 'Starting…';
        if (s.signedIn) return;
        if (s.mine) { const r2 = await fetch(`/api${base}/frame?t=${Date.now()}`, { credentials: 'same-origin' }); if (r2.status === 200) { const u = URL.createObjectURL(await r2.blob()); const old = img.src; img.src = u; if (old.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(old), 2000); } }
      } catch { /* keep trying */ }
      setTimeout(tick, 1000);
    };
    tick();
  },

  // ---------- job search dashboard (your own job agent) ----------
  async jobs(r) {
    const tabs = [['overview', 'Overview'], ['jobs', 'Jobs'], ['questions', 'Questions'], ['referrals', 'Referrals'], ['live', 'Live']];
    const body = h('div', { class: 'scroll jd', id: 'jd' }, h('p', { class: 'loading' }, 'Loading…'));
    app.replaceChildren(
      h('div', { class: 'bar' }, h('a', { class: 'icon back', href: '/', 'data-link': true, 'aria-label': 'Back' }, '‹'),
        h('div', { class: 't' }, h('b', {}, 'Job search'), h('small', { id: 'jdsub' }, 'your job agent'))),
      h('nav', { class: 'jtabs' }, tabs.map(([k, l]) => h('a', { href: k === 'overview' ? '/jobs' : `/jobs/${k}`, 'data-link': true, class: k === r.tab ? 'on' : '' }, l))),
      body);
    if (state.jobName) document.getElementById('jdsub').textContent = `${state.jobName}'s job agent`;
    try { await jobTabs[r.tab](body); } catch (e) { body.replaceChildren(h('p', { class: 'loading' }, e.message)); }
  },

  list() {
    app.replaceChildren(
      h('div', { class: 'bar' }, h('div', { class: 't' }, h('h1', {}, 'Cupboard'), h('small', { id: 'phone' }, 'served from home')),
        h('a', { class: 'icon', href: '/search', 'data-link': true, 'aria-label': 'Search messages', title: 'Search' }, '🔍'),
        h('a', { class: 'icon', href: '/together', 'data-link': true, 'aria-label': 'Lists and calendar', title: 'Lists and calendar' }, '🗓'),
        h('a', { class: 'icon', href: '/jobs', 'data-link': true, 'aria-label': 'Job search', title: 'Job search' }, '💼'),
        h('a', { class: 'icon', href: '/new', 'data-link': true, 'aria-label': 'New chat', title: 'New chat' }, '✎'),
        h('a', { class: 'icon', href: '/me', 'data-link': true, 'aria-label': 'Settings', title: 'Settings' }, '⚙')),
      h('div', { class: 'scroll', id: 'list' }));
    drawList();
    api('/status').then((s) => { const el = document.getElementById('phone'); if (el && s.battery != null) el.textContent = `served from home · 🔋${s.battery}% · ${Math.round(s.tempC)}°C`; }).catch(() => {});
  },

  async chat(r) {
    app.replaceChildren(
      h('div', { class: 'bar', id: 'chatbar' }),
      h('div', { id: 'pins' }),
      h('div', { class: 'msgs', id: 'msgs' }, h('p', { class: 'loading' }, 'Loading…')),
      h('div', { id: 'composer' }));
    await openConv(r.id);
    drawComposer();
    const at = Number(new URLSearchParams(location.search).get('m'));
    if (at) scrollToMessage(at);
  },

  archived() {
    app.replaceChildren(
      h('div', { class: 'bar' }, h('a', { class: 'icon back', href: '/', 'data-link': true, 'aria-label': 'Back' }, '‹'), h('div', { class: 't' }, h('b', {}, 'Archived'), h('small', {}, 'new messages keep them here; long-press a chat to unarchive'))),
      h('div', { class: 'scroll', id: 'list' }));
    drawList();
  },

  // Search every chat: text, captions and file names. A result opens the chat at that message.
  search() {
    const q = h('input', { type: 'search', class: 'jsearch', placeholder: 'Search all chats', autocapitalize: 'none', enterkeyhint: 'search', 'aria-label': 'Search all chats' });
    const out = h('div', {});
    let t;
    const run = async () => {
      const term = q.value.trim();
      if (term.length < 2) { out.replaceChildren(h('p', { class: 'empty' }, 'Type at least 2 letters.')); return; }
      const { results } = await api(`/search?q=${encodeURIComponent(term)}`).catch((e) => { toast(e.message, true); return { results: [] }; });
      if (q.value.trim() !== term) return;
      out.replaceChildren(...(results.length ? results.map(({ msg, title }) => {
        const text = preview(msg), i = text.toLowerCase().indexOf(term.toLowerCase());
        const snip = i < 0 ? text : [text.slice(Math.max(0, i - 30), i), h('mark', {}, text.slice(i, i + term.length)), text.slice(i + term.length, i + term.length + 80)];
        return h('a', { class: 'row', href: `/c/${msg.conv}?m=${msg.id}`, 'data-link': true },
          h('div', { class: 'mid' }, h('div', { class: 'name' }, h('span', {}, title), h('small', {}, when(msg.at))), h('div', { class: 'prev' }, h('span', {}, i > 30 ? '…' : '', snip))));
      }) : [h('p', { class: 'empty' }, 'Nothing found.')]));
    };
    q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(run, 300); });
    app.replaceChildren(h('div', { class: 'bar' }, h('a', { class: 'icon back', href: '/', 'data-link': true, 'aria-label': 'Back' }, '‹'), h('div', { class: 't' }, h('b', {}, 'Search'))),
      h('div', { class: 'scroll' }, h('div', { class: 'jpad' }, q), out));
    q.focus();
  },

  // A chat's photos, videos and documents.
  async media(r) {
    const conv = convById(r.id) || (await api(`/convs/${r.id}`)).conv;
    const { media } = await api(`/convs/${r.id}/media`);
    const visual = media.filter((m) => m.kind !== 'file'), docs = media.filter((m) => m.kind === 'file');
    const grid = h('div', { class: 'gallery' }, visual.map((m) => {
      const tile = h('button', { class: 'gtile', type: 'button', 'aria-label': m.kind === 'video' ? 'Video' : 'Photo' },
        m.kind === 'image' ? h('img', { src: m.media, loading: 'lazy', alt: '' }) : h('span', { class: 'vt' }, '▶'));
      tile.addEventListener('click', () => viewer(m));
      return tile;
    }));
    app.replaceChildren(
      h('div', { class: 'bar' }, h('a', { class: 'icon back', href: `/c/${r.id}`, 'data-link': true, 'aria-label': 'Back' }, '‹'), h('div', { class: 't' }, h('b', {}, 'Media and files'), h('small', {}, conv.title))),
      h('div', { class: 'scroll' },
        h('div', { class: 'sec pad' }, `Photos and videos (${visual.length})`), visual.length ? grid : h('p', { class: 'soft pad' }, 'None yet.'),
        h('div', { class: 'sec pad' }, `Documents (${docs.length})`),
        ...(docs.length ? docs.map((m) => h('a', { class: 'row', href: m.media, download: m.extra?.name || '' },
          h('div', { class: 'av k2' }, '📄'), h('div', { class: 'mid' }, h('div', { class: 'name' }, h('span', {}, m.extra?.name || 'File'), h('small', {}, when(m.at))),
            h('div', { class: 'prev' }, h('span', {}, `${Math.max(1, Math.round((m.extra?.size || 0) / 1024))} KB`)))))
          : [h('p', { class: 'soft pad' }, 'None yet.')])));
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
    // Trusted devices: remove a lost one, or add a new one with a 15-minute link.
    const devBox = h('div', {}), devOut = h('div', {});
    const paintDevices = async () => {
      const { devices } = await api('/devices').catch(() => ({ devices: [] }));
      devBox.replaceChildren(...devices.map((d) => {
        const x = h('button', { class: 'x', type: 'button' }, 'Remove');
        x.addEventListener('click', async () => {
          if (!confirm(d.current ? 'Remove THIS device? It will be locked out until you add it again from another trusted device.' : `Remove ${d.name}? It will be locked out of Cupboard.`)) return;
          await api(`/devices/${d.id}`, { method: 'DELETE' }); if (d.current) location.reload(); else paintDevices();
        });
        return h('div', { class: 'kv' }, h('span', {}, `${d.name}${d.current ? ' (this one)' : ''}`, h('br'),
          h('small', { class: 'soft' }, `${d.who || 'not signed in yet'} · last used ${when(d.seen || d.created)}`)), x);
      }));
    };
    const addDev = h('button', { class: 'btn ghost', type: 'button' }, 'Add a device');
    addDev.addEventListener('click', async () => {
      try {
        const { path } = await api('/devices/link', { method: 'POST' });
        const url = location.origin + path;
        const copy = h('button', { class: 'btn ghost', type: 'button' }, 'Copy');
        copy.addEventListener('click', async () => { await navigator.clipboard.writeText(url); toast('Copied'); });
        const share = navigator.share ? h('button', { class: 'btn', type: 'button' }, 'Share…') : null;
        share?.addEventListener('click', () => navigator.share({ url }).catch(() => {}));
        devOut.replaceChildren(h('p', { class: 'lede' }, 'Open this on the new phone or computer within 15 minutes. It works once.'), h('div', { class: 'link' }, url), h('div', { style: 'display:flex;gap:.5rem' }, share, copy));
      } catch (e) { toast(e.message, true); }
    });
    paintDevices();
    app.replaceChildren(
      h('div', { class: 'bar' }, h('a', { class: 'icon back', href: '/', 'data-link': true, 'aria-label': 'Back' }, '‹'), h('div', { class: 't' }, h('b', {}, 'Settings'))),
      h('div', { class: 'page' },
        h('h2', {}, state.me.name), h('p', { class: 'lede' }, '@' + state.me.username + (owner ? ' · owner' : '')),
        h('div', { class: 'sec' }, 'Notifications'),
        !isStandalone() && isIOS() ? h('p', { class: 'lede' }, 'On iPhone, notifications work once Cupboard is on your Home Screen: Safari → Share → Add to Home Screen, then open it from there.') : null,
        notif,
        !isStandalone() ? h('div', {}, h('div', { class: 'sec' }, 'Install'), h('p', { class: 'lede' }, isIOS() ? 'Safari → Share (□↑) → Add to Home Screen.' : 'Browser menu → Install app / Add to Home screen.')) : null,
        owner ? h('div', {}, h('div', { class: 'sec' }, 'People'), ...(people.length ? people : [h('p', { class: 'lede' }, 'Nobody yet. Invite friends from ✎ → Invite a friend.')])) : null,
        h('div', { class: 'sec' }, 'Devices'),
        h('p', { class: 'lede' }, 'Only these phones and computers can open Cupboard. Anything else sees a blank page.'),
        devBox, addDev, devOut,
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
  const showArchived = route().name === 'archived';
  const shown = state.convs.filter((c) => !!c.archived === showArchived);
  const archived = state.convs.filter((c) => c.archived);
  if (!showArchived && archived.length) banners.push(h('a', { class: 'row arch', href: '/archived', 'data-link': true }, h('div', { class: 'av k2' }, '🗄'),
    h('div', { class: 'mid' }, h('div', { class: 'name' }, h('span', {}, 'Archived'), h('small', {}, String(archived.length))))));
  list.replaceChildren(...(showArchived ? [] : banners), ...(shown.length ? shown.map((c) => {
    const row = h('a', { class: 'row', href: `/c/${c.id}`, 'data-link': true }, avatar(c),
      h('div', { class: 'mid' },
        h('div', { class: 'name' }, h('span', {}, c.title), h('small', {}, c.muted ? '🔕 ' : '', c.last ? when(c.last.at) : '')),
        h('div', { class: 'prev' }, h('span', {}, (c.last && c.kind === 'group' && c.last.from !== state.me.id ? `${c.people.find((p) => p.id === c.last.from)?.name?.split(' ')[0] || ''}: ` : '') + preview(c.last)),
          c.unread ? h('span', { class: 'badge' + (c.muted ? ' quiet' : '') }, String(c.unread)) : null)));
    onHold(row, () => chatMenu(c));
    return row;
  }) : [h('p', { class: 'empty' }, showArchived ? 'No archived chats.' : 'No chats yet.')]));
}

// Long-press (touch) or right-click (mouse) opens a menu. A plain tap still works as before.
function onHold(el, fn) {
  let t = null, held = false, x0 = 0, y0 = 0;
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); fn(); });
  el.addEventListener('touchstart', (e) => { held = false; x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; t = setTimeout(() => { held = true; navigator.vibrate?.(15); fn(); }, 480); }, { passive: true });
  el.addEventListener('touchmove', (e) => { if (Math.abs(e.touches[0].clientX - x0) + Math.abs(e.touches[0].clientY - y0) > 10) clearTimeout(t); }, { passive: true });
  el.addEventListener('touchend', (e) => { clearTimeout(t); if (held) e.preventDefault(); });
  el.addEventListener('click', (e) => { if (held) { e.preventDefault(); e.stopPropagation(); held = false; } }, true);
}
// Bottom sheet with a list of buttons: [label, fn, {danger}] or a ready element.
function sheet(title, items) {
  const box = h('div', { class: 'sheet' }), close = () => box.remove();
  const inner = h('div', { class: 'sheetin menu' }, title ? h('div', { class: 'mtitle' }, title) : null,
    ...items.filter(Boolean).map((it) => {
      if (it instanceof Node) return it;
      const [label, fn, opt = {}] = it;
      const b = h('button', { type: 'button', class: 'mitem' + (opt.danger ? ' danger' : '') }, label);
      b.addEventListener('click', async () => { close(); try { await fn(); } catch (e) { toast(e.message, true); } });
      return b;
    }),
    (() => { const c = h('button', { type: 'button', class: 'mitem cancel' }, 'Cancel'); c.addEventListener('click', close); return c; })());
  box.addEventListener('click', (e) => { if (e.target === box) close(); });
  box.append(inner); document.body.append(box);
  return close;
}
const convSet = (c, body) => api(`/convs/${c.id}/settings`, { method: 'POST', body }).then(({ conv }) => { upsertConv(conv); if (state.cur?.id === conv.id) { state.cur = conv; drawHeader(); } if (['list', 'archived'].includes(route().name)) drawList(); });
function chatMenu(c) {
  const mute = c.muted
    ? [['🔔 Unmute', () => convSet(c, { mute: 0 }).then(() => toast('Unmuted'))]]
    : [['🔕 Mute for 8 hours', () => convSet(c, { mute: 8 }).then(() => toast('Muted for 8 hours'))],
      ['🔕 Mute for a week', () => convSet(c, { mute: 24 * 7 }).then(() => toast('Muted for a week'))],
      ['🔕 Mute always', () => convSet(c, { mute: -1 }).then(() => toast('Muted'))]];
  sheet(c.title, [
    c.kind !== 'bot' ? ['🖼 Media and files', () => go(`/c/${c.id}/media`)] : null,
    ['🔍 Search messages', () => go('/search')],
    ...mute,
    [c.archived ? '📤 Unarchive' : '🗄 Archive', () => convSet(c, { archived: !c.archived }).then(() => { toast(c.archived ? 'Unarchived' : 'Archived'); if (state.cur?.id === c.id && !c.archived) go('/'); })],
  ]);
}

function drawHeader() {
  const bar = document.getElementById('chatbar');
  const c = state.cur;
  if (!bar || !c) return;
  const t = state.typing[c.id];
  const sub = t && t.until > Date.now() ? h('small', { class: 'typing' }, c.kind === 'group' ? `${t.name} is typing…` : 'typing…')
    : h('small', {}, c.kind === 'bot' ? 'your phone server' : c.kind === 'group' ? c.people.map((p) => (p.id === state.me.id ? 'you' : p.name.split(' ')[0])).join(', ') : '@' + (c.people.find((p) => p.id !== state.me.id)?.username || ''));
  const title = h('button', { class: 't tbtn', type: 'button', 'aria-label': 'Chat options' }, h('b', {}, c.muted ? `${c.title} 🔕` : c.title), sub);
  title.addEventListener('click', () => chatMenu(state.cur));
  const more = h('button', { class: 'icon', type: 'button', 'aria-label': 'Chat options' }, '⋮');
  more.addEventListener('click', () => chatMenu(state.cur));
  // The assistant chat: 🤫 quiets it (it then answers only "@ai …"), ✨ wakes it.
  let ai = null;
  if (c.assistant) {
    ai = h('button', { class: 'icon', type: 'button', title: c.assistant.quiet ? 'Wake the assistant' : 'Quiet the assistant', 'aria-label': c.assistant.quiet ? 'Wake the assistant' : 'Quiet the assistant' }, c.assistant.quiet ? '✨' : '🤫');
    ai.addEventListener('click', () => api(`/convs/${c.id}/assistant`, { method: 'POST', body: { quiet: !c.assistant.quiet } })
      .then(({ conv }) => { upsertConv(conv); state.cur = conv; drawHeader(); }).catch((e) => toast(e.message, true)));
    if (c.assistant.quiet && !(t && t.until > Date.now())) sub.textContent = 'assistant is quiet · start with @ai to ask';
  }
  bar.replaceChildren(h('a', { class: 'icon back', href: c.archived ? '/archived' : '/', 'data-link': true, 'aria-label': 'Back' }, '‹'), avatar(c, true), title, ...(ai ? [ai] : []), more);
}

// Pinned messages: a bar under the header; a tap jumps to the message (and on to the next pin).
function drawPins() {
  const box = document.getElementById('pins');
  if (!box) return;
  const pins = state.cur?.pins || [];
  if (!pins.length) { box.replaceChildren(); return; }
  const i = state.pinIdx % pins.length, p = pins[i];
  const b = h('button', { class: 'pinbar', type: 'button' }, h('span', { class: 'pi' }, '📌'),
    h('span', { class: 'pt' }, h('small', {}, pins.length > 1 ? `Pinned ${i + 1} of ${pins.length}` : 'Pinned'), preview(p)));
  b.addEventListener('click', () => { scrollToMessage(p.id); state.pinIdx = i + 1; drawPins(); });
  box.replaceChildren(b);
}

async function scrollToMessage(id) {
  const box = document.getElementById('msgs');
  if (!box || !state.cur) return;
  if (!state.msgs.some((m) => m.id === id)) {
    const { messages, more, newer } = await api(`/convs/${state.cur.id}/messages?around=${id}`).catch(() => ({}));
    if (!messages) return;
    state.msgs = messages; state.more = more; state.newer = newer; drawMessages(false);
  }
  const el = box.querySelector(`[data-id="${id}"]`);
  if (!el) return toast('That message is no longer here.');
  el.scrollIntoView({ block: 'center' });
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
}

// Full-screen photo or video.
function viewer(m) {
  const box = h('div', { class: 'viewer' });
  const close = h('button', { class: 'vclose', type: 'button', 'aria-label': 'Close' }, '✕');
  const media = m.kind === 'video' ? h('video', { src: m.media, controls: true, playsinline: true, autoplay: true }) : h('img', { src: m.media, alt: m.text || 'Photo' });
  box.append(media, h('div', { class: 'vbar' }, h('span', {}, m.text || ''), h('a', { href: m.media, download: m.extra?.name || '', class: 'vdl' }, 'Save'), close));
  const done = () => box.remove();
  close.addEventListener('click', done);
  box.addEventListener('click', (e) => { if (e.target === box) done(); });
  document.body.append(box);
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
  const meta = h('span', { class: 'meta' }, m.extra?.edited ? 'edited · ' : '', time(m.at), mine ? ' ' : '', mine ? h('span', { class: read ? 'read' : '', title: read ? 'Read' : 'Delivered' }, read ? '✓✓' : '✓') : null);
  if (m.kind === 'deleted') {
    const d = h('div', { class: `m ${mine ? 'out' : 'in'} del`, 'data-id': String(m.id) }, mine ? '🚫 You deleted this message' : '🚫 This message was deleted', h('span', { class: 'meta' }, time(m.at)));
    return d;
  }
  const kids = [];
  if (c.kind === 'group' && !mine && who && prev?.from !== m.from) kids.push(h('span', { class: 'who' }, who.name));
  if (m.extra?.replyTo) {
    const q = state.msgs.find((x) => x.id === m.extra.replyTo);
    const qb = h('button', { type: 'button', class: 'quote' }, q ? preview(q) : '↩ an earlier message');
    qb.addEventListener('click', () => scrollToMessage(m.extra.replyTo));
    kids.push(qb);
  }
  if (m.kind === 'image' || m.kind === 'video') {
    const ratio = m.extra?.w && m.extra?.h ? `aspect-ratio:${m.extra.w}/${m.extra.h}` : '';
    const el = m.kind === 'image' ? h('img', { class: 'pic', src: m.media, loading: 'lazy', alt: m.text || 'Photo', style: ratio })
      : h('video', { class: 'pic', src: m.media, controls: true, playsinline: true, preload: 'metadata', style: ratio });
    if (m.kind === 'image') el.addEventListener('click', () => viewer(m));
    kids.push(el);
    if (m.text) kids.push(h('span', { class: 'cap' }, m.text));
  } else if (m.kind === 'voice') kids.push(voiceBubble(m));
  else if (m.kind === 'file') kids.push(h('a', { class: 'file', href: m.media, target: '_blank', rel: 'noopener' }, `📄 ${m.extra?.name || 'File'}`, h('small', {}, ` ${Math.max(1, Math.round((m.extra?.size || 0) / 1024))} KB`)));
  else if (m.kind === 'card' && m.extra?.list) kids.push(h('span', { class: 'h' }, m.extra.title || '📝 List'), listCard(m));
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
      if (m.extra?.link) { const l = h('button', { type: 'button', class: 'go' }, m.extra.link.label); l.addEventListener('click', () => go(m.extra.link.path)); acts.unshift(l); }
      if (m.extra?.replyTo) { const r = h('button', { type: 'button' }, '↩ Reply'); r.addEventListener('click', () => { state.replyTo = m; drawComposer(); document.querySelector('.compose textarea')?.focus(); }); acts.push(r); }
      if (acts.length) kids.push(h('div', { class: 'acts' }, acts));
    }
  } else if (m.kind !== 'image' && m.kind !== 'video') kids.push(m.text || '');
  kids.push(meta);
  const reacts = Object.entries(m.extra?.reactions || {});
  if (reacts.length) kids.push(h('div', { class: 'reacts' }, reacts.map(([e, ids]) => {
    const b = h('button', { type: 'button', class: ids.includes(state.me.id) ? 'mine' : '', title: ids.map((id) => c.people.find((p) => p.id === id)?.name || '').join(', ') }, e, ids.length > 1 ? ` ${ids.length}` : '');
    b.addEventListener('click', () => react(m, e));
    return b;
  })));
  const el = h('div', { class: `m ${mine ? 'out' : 'in'}${m.kind === 'card' ? ' card' : ''}${m.extra?.list ? ' lc' : ''}${m.kind === 'image' || m.kind === 'video' ? ' media' : ''}`, 'data-id': String(m.id) }, kids);
  onHold(el, () => msgMenu(m));
  return el;
}

const react = (m, emoji) => api(`/messages/${m.id}/react`, { method: 'POST', body: { emoji } }).catch((e) => toast(e.message, true));
// Long-press a message: react, reply, copy, edit, pin, delete for everyone.
function msgMenu(m) {
  const c = state.cur, mine = m.from === state.me.id, mineEditable = mine && c.kind !== 'bot';
  const pinned = (c.pins || []).some((p) => p.id === m.id);
  const emojis = h('div', { class: 'emojis' }, REACTIONS.map((e) => {
    const on = (m.extra?.reactions?.[e] || []).includes(state.me.id);
    const b = h('button', { type: 'button', class: on ? 'on' : '', 'aria-label': `React ${e}` }, e);
    b.addEventListener('click', () => { document.querySelector('.sheet')?.remove(); react(m, e); });
    return b;
  }));
  sheet(null, [
    emojis,
    ['↩ Reply', () => { state.editing = null; state.replyTo = m; drawComposer(); document.querySelector('.compose textarea')?.focus(); }],
    m.text ? ['⧉ Copy text', async () => { await navigator.clipboard.writeText(m.text); toast('Copied'); }] : null,
    mineEditable && ['text', 'image', 'video'].includes(m.kind) ? ['✎ Edit', () => { state.replyTo = null; state.editing = m; drawComposer(); }] : null,
    [pinned ? '📌 Unpin' : '📌 Pin', () => api(`/messages/${m.id}/pin`, { method: 'POST' }).then(() => toast(pinned ? 'Unpinned' : 'Pinned'))],
    mineEditable ? ['🗑 Delete for everyone', async () => { if (!confirm('Delete this message for everyone? This can\'t be undone.')) return; await api(`/messages/${m.id}/delete`, { method: 'POST' }); }, { danger: true }] : null,
    h('div', { class: 'mfoot' }, new Date(m.at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }), m.extra?.edited ? ' · edited' : ''),
  ]);
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
  if (!state.msgs.length) nodes.push(h('p', { class: 'empty' }, state.cur.kind === 'bot' ? `Type "help" to see what ${state.me.role === 'owner' ? 'your S20' : 'I'} can do.` : 'Say hi 👋'));
  if (state.newer) { const b = h('button', { class: 'more', type: 'button' }, 'Latest messages ↓'); b.addEventListener('click', () => openConv(state.cur.id, true)); nodes.push(b); }
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
  const cmds = state.me.role === 'owner' ? ['status', 'room', 'arm', 'disarm', 'spent today', 'spent month', 'help'] : ["what's waiting for me?", 'applied today', 'help'];
  if (c.kind === 'bot') parts.push(h('div', { class: 'chips' }, cmds.map((cmd) => {
    const b = h('button', { type: 'button' }, cmd); b.addEventListener('click', () => sendText(cmd)); return b;
  })));
  if (state.replyTo) {
    const x = h('button', { class: 'icon', type: 'button', 'aria-label': 'Cancel reply' }, '✕');
    x.addEventListener('click', () => { state.replyTo = null; drawComposer(); });
    parts.push(h('div', { class: 'replying' }, h('span', {}, 'Replying to: ' + preview(state.replyTo)), x));
  }
  if (state.tray?.length && !rec) {
    const strip = h('div', { class: 'tray' });
    state.tray.forEach((t, i) => {
      const x = h('button', { type: 'button', class: 'tx', 'aria-label': 'Remove' }, '✕');
      x.addEventListener('click', () => { URL.revokeObjectURL(t.url); state.tray.splice(i, 1); state.draft = document.querySelector('.compose textarea')?.value || ''; drawComposer(); });
      strip.append(h('div', { class: 'th' }, t.file.type.startsWith('video/') ? h('span', { class: 'tv' }, '🎥') : h('img', { src: t.url, alt: `Photo ${i + 1}` }), x));
    });
    if (state.tray.length < 10) {
      const more = h('button', { type: 'button', class: 'tadd2', 'aria-label': 'Add another photo' }, '＋');
      more.addEventListener('click', () => document.getElementById('trayPick')?.click());
      strip.append(more);
    }
    parts.push(h('div', { class: 'traywrap' }, strip, h('small', {}, `${state.tray.length} ready · add the other hand, then press send`)));
  }
  if (state.editing) {
    const x = h('button', { class: 'icon', type: 'button', 'aria-label': 'Cancel editing' }, '✕');
    x.addEventListener('click', () => { state.editing = null; drawComposer(); });
    parts.push(h('div', { class: 'replying editing' }, h('span', {}, 'Editing: ' + preview(state.editing)), x));
  }
  if (rec) {
    const cancel = h('button', { class: 'icon', type: 'button', 'aria-label': 'Cancel recording' }, '✕');
    const send = h('button', { class: 'send', type: 'button', 'aria-label': 'Send voice note' }, '➤');
    cancel.addEventListener('click', () => stopRec(false));
    send.addEventListener('click', () => stopRec(true));
    parts.push(h('div', { class: 'compose' }, cancel, h('div', { class: 'rec' }, h('i'), h('span', { id: 'rect' }, '0:00'), h('div', { class: 'lvl' }, h('b', { id: 'recl' }))), send));
  } else {
    const ta = h('textarea', { rows: '1', placeholder: c.kind === 'bot' ? (state.me.role === 'owner' ? 'Message S20…' : 'Message your job agent…') : state.editing ? 'Edit message' : 'Message', enterkeyhint: 'send', 'aria-label': 'Message' });
    if (state.editing) setTimeout(() => { ta.value = state.editing?.text || ''; sync(); ta.focus(); }, 0);
    else if (state.draft) { ta.value = state.draft; state.draft = ''; }
    const btn = h('button', { class: 'send', type: 'button', 'aria-label': 'Record a voice note' }, '🎤');
    let lastTyping = 0;
    const sync = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 128) + 'px'; const has = !!ta.value.trim() || !!state.editing || !!state.tray?.length; btn.textContent = state.editing ? '✓' : has ? '➤' : '🎤'; btn.setAttribute('aria-label', state.editing ? 'Save edit' : has ? 'Send' : 'Record a voice note'); };
    sync();                                                  // photos waiting in the tray, or a kept draft: show ➤ at once
    ta.addEventListener('input', () => {
      sync();
      if (c.kind !== 'bot' && Date.now() - lastTyping > 3000 && ta.value.trim()) { lastTyping = Date.now(); api(`/convs/${c.id}/typing`, { method: 'POST' }).catch(() => {}); }
    });
    const sendAll = () => { if (state.tray?.length) { const cap = ta.value.trim(); ta.value = ''; sync(); sendTray(c, cap); return true; } return false; };
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !isIOS()) { e.preventDefault(); if (!sendAll() && ta.value.trim()) { sendText(ta.value); ta.value = ''; sync(); } } });
    btn.addEventListener('click', () => { if (sendAll()) return; if (ta.value.trim() || state.editing) { sendText(ta.value); ta.value = ''; sync(); ta.focus(); } else startRec(); });
    // 📎 PDF (a resume) for the bot chat: the person's job agent receives it.
    let clip = null;
    if (c.kind === 'bot') {
      const pick = h('input', { type: 'file', accept: 'application/pdf,.pdf', hidden: '' });
      clip = h('button', { class: 'icon', type: 'button', 'aria-label': 'Attach a PDF' }, '📎');
      clip.addEventListener('click', () => pick.click());
      pick.addEventListener('change', async () => {
        const f = pick.files?.[0]; pick.value = '';
        if (!f) return;
        if (f.size > 4 * 1024 * 1024) return toast('That PDF is over 4 MB.', true);
        clip.disabled = true;
        try { await api(`/convs/${c.id}/file`, { method: 'POST', raw: f, headers: { 'Content-Type': 'application/pdf', 'X-Filename': encodeURIComponent(f.name) } }); }
        catch (e) { toast(e.message, true); }
        clip.disabled = false;
      });
      clip = [pick, clip];
    } else if (!state.editing) {
      // 📎 in chats with people: photos and videos, or documents. The text box becomes the caption.
      const media = h('input', { type: 'file', accept: 'image/*,video/*', multiple: true, hidden: '', id: 'trayPick' });
      const docs = h('input', { type: 'file', accept: '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip', multiple: true, hidden: '' });
      const b = h('button', { class: 'icon', type: 'button', 'aria-label': 'Attach photos, videos or files' }, '📎');
      b.addEventListener('click', () => sheet(null, [['📷 Photo or video', () => media.click()], ['📄 Document', () => docs.click()],
        ['📝 List', () => chatList(c)], ['⏰ Reminder or event', () => eventForm({}, { conv: c.id, reminder: true })]]));
      // Photos wait in a tray so you can take the second hand (or more), then send them all together.
      media.addEventListener('change', () => {
        const files = [...(media.files || [])]; media.value = '';
        if (!files.length) return;
        state.tray = state.tray || [];
        for (const f of files.slice(0, 10 - state.tray.length)) state.tray.push({ file: f, url: URL.createObjectURL(f) });
        state.draft = ta.value; drawComposer();
      });
      docs.addEventListener('change', async () => {
        const files = [...(docs.files || [])].slice(0, 10); docs.value = '';
        const caption = ta.value.trim(); if (files.length) { ta.value = ''; sync(); }
        for (const [i, f] of files.entries()) await upload(c, f, i === 0 ? caption : '');
      });
      clip = [media, docs, b];
    }
    parts.push(h('div', { class: 'compose' }, ...(clip || []), ta, btn));
  }
  wrap.replaceChildren(...parts);
}

function clearTray() { for (const t of state.tray || []) URL.revokeObjectURL(t.url); state.tray = []; }
// Send everything in the tray in order; the caption goes on the first one.
async function sendTray(c, caption) {
  const files = (state.tray || []).map((t) => t.file);
  clearTray(); drawComposer();
  for (const [i, f] of files.entries()) await upload(c, f, i === 0 ? caption : '');
}

async function sendText(text) {
  const t = text.trim();
  if (state.editing) {
    const m = state.editing; state.editing = null; drawComposer();
    if (t !== (m.text || '')) await api(`/messages/${m.id}/edit`, { method: 'POST', body: { text: t } }).catch((e) => toast(e.message, true));
    return;
  }
  if (!t || !state.cur) return;
  const replyTo = state.replyTo?.id || null;
  state.replyTo = null; drawComposer();
  try { await api(`/convs/${state.cur.id}/messages`, { method: 'POST', body: { text: t, replyTo } }); }
  catch (e) { toast(e.message, true); }
}

// Photos are shrunk on the device first (longest side 2048 px, JPEG): quicker to send, small on the server.
async function shrink(file) {
  if (!file.type.startsWith('image/') || file.type === 'image/gif') return { blob: file, type: file.type };
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => null);
  if (!bmp) return { blob: file, type: file.type };
  const k = Math.min(1, 2048 / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * k), hh = Math.round(bmp.height * k);
  const cv = document.createElement('canvas'); cv.width = w; cv.height = hh;
  cv.getContext('2d').drawImage(bmp, 0, 0, w, hh);
  const blob = await new Promise((ok) => cv.toBlob(ok, 'image/jpeg', 0.85));
  return blob ? { blob, type: 'image/jpeg', w, h: hh } : { blob: file, type: file.type };
}
const videoSize = (file) => new Promise((ok) => {
  const v = document.createElement('video'); v.preload = 'metadata'; v.muted = true;
  v.onloadedmetadata = () => { ok({ w: v.videoWidth, h: v.videoHeight }); URL.revokeObjectURL(v.src); };
  v.onerror = () => ok({}); v.src = URL.createObjectURL(file);
});
const TYPES = { pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', zip: 'application/zip', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
async function upload(c, file, caption) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  let { blob, type, w, h: hh } = await shrink(file);
  if (!type || type === 'application/octet-stream') type = TYPES[ext] || type;
  if (type.startsWith('video/')) ({ w, h: hh } = await videoSize(file));
  const mb = blob.size / 1048576, max = type.startsWith('video/') ? 60 : type.startsWith('image/') ? 15 : 25;
  if (mb > max) return toast(`${file.name} is ${mb.toFixed(0)} MB: the limit is ${max} MB.`, true);
  toast(`Sending ${type.startsWith('image/') ? 'photo' : type.startsWith('video/') ? 'video' : file.name}…`);
  const replyTo = state.replyTo?.id; state.replyTo = null; drawComposer();
  const headers = { 'Content-Type': type, 'X-Filename': encodeURIComponent(file.name) };
  if (caption) headers['X-Caption'] = encodeURIComponent(caption);
  if (w && hh) { headers['X-Width'] = String(w); headers['X-Height'] = String(hh); }
  try { await api(`/convs/${c.id}/upload${replyTo ? `?replyTo=${replyTo}` : ''}`, { method: 'POST', raw: blob, headers }); }
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

// ---------- job dashboard tabs ----------
const LABEL = { new: 'New', scored: 'Scored', filtered: 'Filtered out', queued: 'In queue', applying: 'Applying now', ready: 'Filled (not sent)',
  needs_answer: 'Waiting for your answer', captcha: 'Needs you (CAPTCHA)', manual: 'Apply yourself', claimed: 'You are applying', applied: 'Applied',
  interview: 'Interview', rejected: 'Rejected', failed: 'Failed', skipped: 'Skipped' };
const STAGE = { drafted: 'Draft: needs your OK', approved: 'Approved, sending soon', invited: 'Invite sent', accepted: 'Connected',
  followup_drafted: 'Follow-up: needs your OK', followup_approved: 'Follow-up approved', followup_sent: 'Asked for referral', replied: 'Replied',
  referred: 'Referred ✓', skipped: 'Skipped', failed: 'Failed' };
const act = (action, id, answer) => api('/jobs/action', { method: 'POST', body: { action, id, answer } });
const ago = (t) => { const m = (Date.now() - t) / 60000; return m < 60 ? `${Math.max(1, Math.round(m))}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`; };
const stat = (n, l) => h('div', { class: 'stat' }, h('b', {}, String(n)), h('small', {}, l));
const sec = (title, ...kids) => h('section', { class: 'jsec' }, h('h3', {}, title), ...kids);
let jobTimer = null;
const jobTabs = {
  async overview(box) {
    const s = await api('/jobs/summary');
    state.jobName = s.name;
    document.getElementById('jdsub').textContent = s.name ? `${s.name}'s job agent` : 'your job agent';
    const mode = s.paused ? '⏸ Paused' : s.dryRun ? '🧪 Fill-only: forms are filled but not sent' : '🚀 Live: applying for you';
    const modeBtns = [];
    const btn = (label, action, cls = '') => { const b = h('button', { class: `btn ${cls}`, type: 'button' }, label);
      b.addEventListener('click', async () => { b.disabled = true; try { await act(action); go(location.pathname, true); } catch (e) { toast(e.message, true); b.disabled = false; } }); return b; };
    if (s.dryRun) modeBtns.push(btn('Go live', 'live'));
    else modeBtns.push(btn('Fill-only', 'dry', 'ghost'));
    modeBtns.push(s.paused ? btn('Resume', 'resume') : btn('Pause', 'pause', 'ghost'));
    const conn = (key, label) => {
      const ok = s.connected[key];
      const row = h('div', { class: 'conn' }, h('span', {}, `${ok ? '✅' : '⚪️'} ${label}`));
      if (!ok) {
        const b = h('button', { class: 'btn ghost sm', type: 'button' }, 'Connect');
        b.addEventListener('click', async () => {
          if (key === 'gmail') { const c = state.convs.find((x) => x.kind === 'bot'); if (c) { await api(`/convs/${c.id}/messages`, { method: 'POST', body: { text: 'login gmail' } }).catch(() => {}); go(`/c/${c.id}`); } return; }
          try { const { path } = await api('/jobs/signin', { method: 'POST', body: { site: key } }); go(path); } catch (e) { toast(e.message, true); }
        });
        row.append(b);
      }
      return row;
    };
    const max = Math.max(1, ...s.days.map((d) => d.n));
    const days = Array.from({ length: 14 }, (_, i) => { const d = new Date(Date.now() + 5.5 * 3600e3 - (13 - i) * 864e5).toISOString().slice(0, 10); return { d, n: s.days.find((x) => x.d === d)?.n || 0 }; });
    const kids = [];
    if (s.setup) kids.push(h('p', { class: 'warn' }, '👋 Setup isn\'t finished yet. Open your "Job agent" chat to continue.'));
    kids.push(sec('Status', h('p', { class: 'mode' }, mode), s.now?.text ? h('p', { class: 'soft' }, `Now: ${s.now.text}`) : null, h('div', { class: 'btns' }, modeBtns)));
    kids.push(h('div', { class: 'stats' }, stat(s.today.found, 'found today'), stat(s.today.matched, `fit ≥ ${s.minScore}%`), stat(s.today.applied, 'applied today'), stat(s.total.applied, 'applied total'), stat(s.total.interviews, 'interviews')));
    kids.push(sec('Applied, last 14 days', h('div', { class: 'bars' }, days.map((d) => h('i', { title: `${d.d}: ${d.n}`, style: `height:${Math.round((d.n / max) * 100)}%` })))));
    if (s.questions.length) kids.push(sec(`Questions for you (${s.questions.length})`, ...s.questions.slice(0, 5).map(qCard), s.questions.length > 5 ? h('a', { href: '/jobs/questions', 'data-link': true, class: 'more' }, 'All questions →') : null));
    if (s.drafts) kids.push(sec('Referrals', h('a', { href: '/jobs/referrals', 'data-link': true, class: 'more' }, `${s.drafts} draft(s) waiting for your OK →`)));
    if (s.attention.length) kids.push(sec('Needs you', ...s.attention.map(jobRow)));
    kids.push(sec('Accounts', conn('linkedin', 'LinkedIn'), conn('naukri', 'Naukri'), conn('gmail', `Gmail${s.connected.mailbox ? ` (${s.connected.mailbox})` : ''}`)));
    box.replaceChildren(...kids.filter(Boolean));
  },
  async jobs(box) {
    const filters = [['matches', 'Matches'], ['queued', 'Queue'], ['applied', 'Applied'], ['needs_answer', 'Waiting'], ['manual', 'Apply yourself'], ['interview', 'Interview'], ['failed', 'Failed'], ['all', 'All']];
    let status = 'matches', q = '', page = 0;
    const listEl = h('div', {});
    const search = h('input', { type: 'search', placeholder: 'Search title or company', class: 'jsearch' });
    const chips = h('div', { class: 'chips flat' }, filters.map(([k, l]) => { const b = h('button', { type: 'button', class: k === status ? 'on' : '' }, l);
      b.addEventListener('click', () => { status = k; page = 0; [...chips.children].forEach((c) => c.classList.toggle('on', c === b)); load(); }); return b; }));
    let t; search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { q = search.value; page = 0; load(); }, 300); });
    const more = h('button', { class: 'btn ghost full', type: 'button' }, 'Load more');
    more.addEventListener('click', () => { page++; load(true); });
    async function load(append) {
      const { jobs } = await api(`/jobs/list?status=${status}&q=${encodeURIComponent(q)}&page=${page}`);
      const rows = jobs.map(jobRow);
      if (append) listEl.append(...rows); else listEl.replaceChildren(...(rows.length ? rows : [h('p', { class: 'loading' }, 'Nothing here yet.')]));
      more.hidden = jobs.length < 40;
    }
    box.replaceChildren(h('div', { class: 'jpad' }, search), chips, listEl, h('div', { class: 'jpad' }, more));
    await load();
  },
  async questions(box) {
    const { open, answers } = await api('/jobs/memory');
    const learned = answers.map((a) => {
      const row = h('div', { class: 'qa' }, h('b', {}, a.question), h('p', {}, a.answer), a.uses ? h('small', {}, `used ${a.uses}×`) : null);
      const edit = h('button', { class: 'btn ghost sm', type: 'button' }, 'Change');
      edit.addEventListener('click', () => row.replaceWith(qCard({ id: a.id, question: a.question, value: a.answer })));
      row.append(edit);
      return row;
    });
    box.replaceChildren(sec(`Waiting for your answer (${open.length})`, ...(open.length ? open.map(qCard) : [h('p', { class: 'soft' }, 'Nothing waiting. 🎉')])),
      sec(`What I know about you (${answers.length})`, h('p', { class: 'soft' }, 'I reuse these on every application. Change any of them anytime.'), ...learned));
  },
  async referrals(box) {
    const { rows, companies } = await api('/jobs/referrals');
    const card = (r) => {
      const draft = ['drafted', 'followup_drafted'].includes(r.stage);
      const text = draft ? h('textarea', { rows: '5', class: 'jta' }) : null;
      if (text) text.value = r.stage === 'followup_drafted' ? r.followup || '' : r.note || '';
      const kids = [h('div', { class: 'rhead' }, h('a', { href: r.profile, target: '_blank', rel: 'noopener' }, h('b', {}, r.person)), h('span', { class: 'tag' }, STAGE[r.stage] || r.stage)),
        h('small', {}, `${r.company}${r.job_title ? ` · ${r.job_title}` : ''}${r.alumni ? ' · alum' : ''}`), r.headline ? h('p', { class: 'soft' }, r.headline) : null];
      if (draft) {
        const send = h('button', { class: 'btn sm', type: 'button' }, 'Send'), skip = h('button', { class: 'btn ghost sm', type: 'button' }, 'Skip');
        const orig = text.value;
        send.addEventListener('click', async () => { send.disabled = true; try { const o = await act('ref_decide', r.id, text.value.trim() === orig.trim() ? 'ok' : text.value.trim()); toast(o.message || 'Sent'); go(location.pathname, true); } catch (e) { toast(e.message, true); send.disabled = false; } });
        skip.addEventListener('click', async () => { try { await act('ref_decide', r.id, 'skip'); go(location.pathname, true); } catch (e) { toast(e.message, true); } });
        kids.push(text, h('div', { class: 'btns' }, send, skip));
      } else if (r.note) kids.push(h('p', { class: 'soft clip' }, r.note));
      return h('div', { class: 'rcard' }, kids.filter(Boolean));
    };
    box.replaceChildren(sec('Referral requests', h('p', { class: 'soft' }, `Nothing is sent without your OK. Target companies: ${companies.length ? companies.join(', ') : 'companies where you are a strong match'}.`),
      ...(rows.length ? rows.map(card) : [h('p', { class: 'soft' }, 'None yet. They start once LinkedIn is connected.')])));
  },
  async live(box) {
    const img = h('img', { class: 'screen', alt: 'Phone browser', hidden: true });
    const cap = h('p', { class: 'soft' }, 'The phone\'s browser shows up here while it works on one of your applications.');
    const term = h('pre', { class: 'term' });
    box.replaceChildren(sec('Phone browser', cap, img), sec('What your agent is doing', term));
    let offset;
    const tick = async () => {
      if (route().name !== 'jobs' || route().tab !== 'live') return;
      try {
        const r = await fetch(`/api/jobs/screen?t=${Date.now()}`, { credentials: 'same-origin' });
        if (r.status === 200) { const u = URL.createObjectURL(await r.blob()); const old = img.src; img.src = u; img.hidden = false; cap.textContent = `Working on: ${decodeURIComponent(r.headers.get('x-task') || '')}`; if (old.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(old), 3000); }
        else { img.hidden = true; cap.textContent = 'The phone\'s browser shows up here while it works on one of your applications.'; }
        const l = await api(`/jobs/log${offset != null ? `?since=${offset}` : ''}`);
        offset = l.offset;
        if (l.lines.length) {
          const atBottom = term.scrollHeight - term.scrollTop - term.clientHeight < 40;
          term.append(...l.lines.map((x) => h('div', {}, h('span', { class: 'ts' }, time(Date.parse(x.slice(0, 24)))), ' ', x.slice(25))));
          while (term.childElementCount > 400) term.firstChild.remove();
          if (atBottom || l.lines.length > 50) term.scrollTop = term.scrollHeight;
        }
      } catch { /* keep polling */ }
      clearTimeout(jobTimer); jobTimer = setTimeout(tick, 2500);
    };
    tick();
  },
};
function qCard(q) {
  const opts = (() => { try { return JSON.parse(q.options || 'null'); } catch { return null; } })();
  const inp = h('textarea', { rows: '2', class: 'jta', placeholder: 'Your answer' });
  if (q.value) inp.value = q.value;
  const save = h('button', { class: 'btn sm', type: 'button' }, 'Save');
  const box = h('div', { class: 'qa ask' }, h('b', {}, q.question));
  if (opts?.length) box.append(h('div', { class: 'chips flat' }, opts.map((o) => { const b = h('button', { type: 'button' }, o); b.addEventListener('click', () => { inp.value = o; }); return b; })));
  save.addEventListener('click', async () => { if (!inp.value.trim()) return; save.disabled = true;
    try { await act('answer', q.id, inp.value.trim()); toast('Saved. I\'ll use it from now on.'); box.replaceWith(h('div', { class: 'qa' }, h('b', {}, q.question), h('p', {}, inp.value.trim()))); }
    catch (e) { toast(e.message, true); save.disabled = false; } });
  box.append(inp, h('div', { class: 'btns' }, save));
  return box;
}
function jobRow(j) {
  const row = h('button', { class: 'jrow', type: 'button' },
    h('span', { class: `score${j.score >= 80 ? ' hi' : ''}` }, j.score != null ? `${j.score}` : '–'),
    h('span', { class: 'mid' }, h('b', {}, j.title || ''), h('small', {}, `${j.company || ''}${j.location ? ` · ${j.location}` : ''}`)),
    h('span', { class: 'st' }, LABEL[j.status] || j.status, h('small', {}, ago(j.applied_at || j.found_at))));
  row.addEventListener('click', () => openJob(j.id));
  return row;
}
async function openJob(id) {
  const j = await api(`/jobs/detail?id=${encodeURIComponent(id)}`).catch((e) => { toast(e.message, true); return null; });
  if (!j) return;
  const close = h('button', { class: 'icon', type: 'button', 'aria-label': 'Close' }, '✕');
  const b = (label, action, cls = 'ghost') => { const x = h('button', { class: `btn sm ${cls}`, type: 'button' }, label);
    x.addEventListener('click', async () => { x.disabled = true; try { await act(action, j.id); toast('Done'); sheet.remove(); } catch (e) { toast(e.message, true); x.disabled = false; } }); return x; };
  const acts = [];
  if (!['applied', 'interview'].includes(j.status)) acts.push(b("I'm applying myself", 'claim'), b('Mark applied', 'applied'), b('Skip', 'skip'));
  if (['failed', 'skipped', 'manual', 'filtered', 'scored'].includes(j.status)) acts.unshift(b('Let the agent apply', 'queue', ''));
  const sheet = h('div', { class: 'sheet' }, h('div', { class: 'sheetin' },
    h('div', { class: 'rhead' }, h('b', {}, j.title), close),
    h('p', { class: 'soft' }, `${j.company} · ${j.location || ''} · ${j.source}`),
    h('p', {}, h('span', { class: 'tag' }, LABEL[j.status] || j.status), j.score != null ? ` Fit ${j.score}%` : ''),
    j.score_reasons ? h('p', { class: 'soft' }, j.score_reasons) : null,
    j.status_note && !/\.png$/.test(j.status_note) ? h('p', { class: 'soft' }, j.status_note) : null,
    h('div', { class: 'btns' }, h('a', { class: 'btn sm', href: j.apply_url || j.url, target: '_blank', rel: 'noopener' }, 'Open job ↗'), ...acts),
    j.attempts?.length ? h('details', {}, h('summary', {}, `Attempts (${j.attempts.length})`), ...j.attempts.map((a) => h('p', { class: 'soft' }, `${new Date(a.at).toLocaleString('en-IN')} · ${a.status} · ${a.reason || ''}`))) : null,
    h('details', {}, h('summary', {}, 'Job description'), h('p', { class: 'jdesc' }, j.description || '—'))));
  close.addEventListener('click', () => sheet.remove());
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.remove(); });
  document.body.append(sheet);
}

// ---------- Together: shared lists and a shared calendar (each belongs to a chat; "Just me" = your own bot chat) ----------
const listCache = new Map(), listPending = new Set();
const back = (href) => h('a', { class: 'icon back', href, 'data-link': true, 'aria-label': 'Back' }, '‹');
const EVERY = { daily: 'every day', weekly: 'every week', monthly: 'every month' };
async function loadTogether() {
  state.tg = await api('/together');
  for (const l of state.tg.lists) listCache.set(l.id, l);
  return state.tg;
}
const tgList = (id) => (listCache.has(id) ? listCache.get(id) : state.tg?.lists.find((l) => l.id === id));
const tgConv = (id) => state.tg?.convs.find((c) => c.id === id);
const nameOf = (id) => (id === state.me.id ? 'you' : state.convs.flatMap((c) => c.people).find((p) => p.id === id)?.name.split(' ')[0] || 'someone');
const sharedWith = (convId) => { const c = tgConv(convId); return !c ? '' : c.kind === 'bot' ? 'just you' : c.kind === 'group' ? c.title : `you and ${c.title.split(' ')[0]}`; };

function redrawTogether() {
  const r = route();
  if (r.name === 'together' && state.tg) drawTogether();
  if (r.name === 'tlist') drawTList();
  if (r.name === 'chat' && state.msgs.some((m) => m.extra?.list)) drawMessages(false);
}
function upsertList(l) {
  listCache.set(l.id, l);
  if (state.tg) { const i = state.tg.lists.findIndex((x) => x.id === l.id); if (i >= 0) state.tg.lists[i] = l; else state.tg.lists.unshift(l); }
  redrawTogether();
}
function dropList(id) {
  listCache.set(id, null);
  if (state.tg) state.tg.lists = state.tg.lists.filter((l) => l.id !== id);
  redrawTogether();
}
function upsertEvent(e) {
  if (!state.tg) return;
  const i = state.tg.events.findIndex((x) => x.id === e.id);
  if (i >= 0) state.tg.events[i] = e; else state.tg.events.push(e);
  redrawTogether();
}
function dropEvent(id) { if (state.tg) { state.tg.events = state.tg.events.filter((e) => e.id !== id); redrawTogether(); } }

screens.together = async (r) => {
  const add = h('button', { class: 'icon', type: 'button', 'aria-label': r.tab === 'cal' ? 'New event or reminder' : 'New list' }, '＋');
  add.addEventListener('click', () => (route().tab === 'cal' ? eventForm(state.calSel ? { date: state.calSel } : {}) : listForm()));
  app.replaceChildren(
    h('div', { class: 'bar' }, back('/'), h('div', { class: 't' }, h('b', {}, 'Together'), h('small', {}, 'shared lists and calendar')), add),
    h('nav', { class: 'jtabs' }, h('a', { href: '/together', 'data-link': true, class: r.tab === 'lists' ? 'on' : '' }, 'Lists'),
      h('a', { href: '/together/calendar', 'data-link': true, class: r.tab === 'cal' ? 'on' : '' }, 'Calendar')),
    h('div', { class: 'scroll', id: 'tg' }, h('p', { class: 'loading' }, 'Loading…')));
  await loadTogether();
  drawTogether();
};
function drawTogether() {
  const box = document.getElementById('tg');
  if (!box) return;
  const y = box.scrollTop;
  (route().tab === 'cal' ? drawCal : drawLists)(box);
  box.scrollTop = y;
}

// ----- lists -----
function listRow(l) {
  const n = l.items.length, left = l.items.filter((i) => !i.done).length;
  return h('a', { class: 'row', href: `/together/list/${l.id}`, 'data-link': true }, h('div', { class: 'temo' }, l.emoji || '📝'),
    h('div', { class: 'mid' }, h('div', { class: 'name' }, h('span', {}, l.title), h('small', {}, when(l.updated))),
      h('div', { class: 'prev' }, h('span', {}, `${!n ? 'empty' : left ? `${left} of ${n} left` : `all ${n} done ✓`} · ${sharedWith(l.conv)}`))),
    h('div', { class: 'prog', 'aria-hidden': 'true' }, h('i', { style: `width:${n ? Math.round(((n - left) / n) * 100) : 0}%` })));
}
function drawLists(box) {
  const active = state.tg.lists.filter((l) => !l.archived), arch = state.tg.lists.filter((l) => l.archived);
  const chip = (label, fn) => { const b = h('button', { type: 'button' }, label); b.addEventListener('click', fn); return b; };
  box.replaceChildren(...[
    ...(active.length ? active.map(listRow) : [h('p', { class: 'empty' }, 'No lists yet. Start one:')]),
    h('div', { class: 'chips flat twrap' }, chip('🛒 Groceries', () => listForm({ emoji: '🛒', title: 'Groceries' })), chip('✅ To-dos', () => listForm({ emoji: '✅', title: 'To-dos' })),
      chip('🧳 Packing', () => listForm({ emoji: '🧳', title: 'Packing' })), chip('＋ Other list', () => listForm())),
    arch.length ? h('details', { class: 'tarch' }, h('summary', {}, `Archived (${arch.length})`), arch.map(listRow)) : null].filter(Boolean));
}

function convSelect(value) {
  const sel = h('select', { 'aria-label': 'Shared with' }, state.tg.convs.map((c) => h('option', { value: String(c.id) },
    c.kind === 'bot' ? 'Just me' : c.kind === 'group' ? `Group · ${c.title}` : `Me and ${c.title}`)));
  const dm = state.tg.convs.find((c) => c.kind === 'dm');
  sel.value = String(value || dm?.id || state.tg.convs[0]?.id || '');
  return sel;
}
const fld = (label, el) => h(el.tagName === 'DIV' ? 'div' : 'label', { class: 'field' }, h('span', {}, label), el);
// A form in a bottom sheet. onSubmit throws to keep it open and show the error.
function formSheet(title, fields, label, onSubmit, extra) {
  const err = h('p', { class: 'err' });
  const ok = h('button', { class: 'btn full', type: 'submit' }, label);
  const f = h('form', { class: 'tform' }, h('div', { class: 'mtitle' }, title), ...fields, ok, extra || null, err);
  const close = sheet(null, [f]);
  f.addEventListener('submit', async (e) => {
    e.preventDefault(); ok.disabled = true; err.textContent = '';
    try { await onSubmit(); close(); } catch (x) { err.textContent = x.message; ok.disabled = false; }
  });
  return close;
}

async function listForm(pre = {}, conv = null, after = null) {
  if (!state.tg) await loadTogether();
  const title = h('input', { maxlength: '60', required: true, value: pre.title || '', placeholder: 'e.g. Groceries', autocapitalize: 'sentences' });
  let emoji = pre.emoji || '📝';
  const emos = h('div', { class: 'temos' }, ['📝', '🛒', '✅', '🧳', '🎁', '🏠', '💊', '🍳', '📚', '🎬'].map((e) => {
    const b = h('button', { type: 'button', class: e === emoji ? 'on' : '', 'aria-label': `Icon ${e}` }, e);
    b.addEventListener('click', () => { emoji = e; [...emos.children].forEach((x) => x.classList.toggle('on', x === b)); });
    return b;
  }));
  const sel = convSelect(conv);
  formSheet('New list', [fld('Name', title), fld('Icon', emos), fld('Shared with', sel)], 'Create list', async () => {
    const { list } = await api('/lists', { method: 'POST', body: { title: title.value, emoji, conv: Number(sel.value) } });
    upsertList(list);
    if (after) await after(list); else go(`/together/list/${list.id}`);
  });
  setTimeout(() => title.focus(), 60);
}

screens.tlist = async (r) => {
  if (!state.tg) await loadTogether();
  if (!tgList(r.id)) upsertList((await api(`/lists/${r.id}`)).list);
  const ta = h('textarea', { rows: '1', placeholder: 'Add an item (or paste several lines)', 'aria-label': 'Add an item', enterkeyhint: 'done', autocapitalize: 'sentences' });
  const addB = h('button', { class: 'send', type: 'button', 'aria-label': 'Add item' }, '＋');
  const addIt = async () => {
    const t = ta.value.trim(); if (!t) return;
    ta.value = '';
    try { upsertList((await api(`/lists/${r.id}/items`, { method: 'POST', body: { text: t } })).list); } catch (e) { toast(e.message, true); ta.value = t; }
    ta.focus();
  };
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addIt(); } });
  addB.addEventListener('click', addIt);
  const more = h('button', { class: 'icon', type: 'button', 'aria-label': 'List options' }, '⋮');
  more.addEventListener('click', () => listMenu(tgList(r.id)));
  app.replaceChildren(h('div', { class: 'bar' }, back('/together'), h('div', { class: 't', id: 'tlt' }), more),
    h('div', { class: 'scroll', id: 'titems' }), h('div', { class: 'compose' }, ta, addB));
  drawTList();
};
function drawTList() {
  const r = route(), box = document.getElementById('titems'), t = document.getElementById('tlt');
  if (r.name !== 'tlist' || !box) return;
  const l = tgList(r.id);
  if (!l) { t.replaceChildren(h('b', {}, 'List')); box.replaceChildren(h('p', { class: 'empty' }, 'This list was deleted.')); return; }
  const open = l.items.filter((i) => !i.done), done = l.items.filter((i) => i.done);
  t.replaceChildren(h('b', {}, `${l.emoji || '📝'} ${l.title}`), h('small', {}, `${open.length} to go · ${sharedWith(l.conv)}${l.archived ? ' · archived' : ''}`));
  const clear = h('button', { class: 'more tclear', type: 'button' }, 'Clear ticked items');
  clear.addEventListener('click', () => api(`/lists/${l.id}/clear`, { method: 'POST' }).then(({ list }) => upsertList(list)).catch((e) => toast(e.message, true)));
  box.replaceChildren(...[
    ...(open.length ? open.map((i) => itemRow(i)) : [h('p', { class: 'empty' }, l.items.length ? 'All done ✓' : 'Nothing here yet. Add items below.')]),
    done.length ? h('div', { class: 'sec pad' }, `Ticked (${done.length})`) : null,
    ...done.map((i) => itemRow(i)),
    done.length ? clear : null].filter(Boolean));
}
function itemRow(i, inCard) {
  const by = i.done ? `✓ ${nameOf(i.doneBy)}` : !inCard && i.by !== state.me.id ? nameOf(i.by) : '';
  const b = h('button', { class: 'chk' + (i.done ? ' done' : ''), type: 'button', 'aria-pressed': String(i.done) },
    h('span', { class: 'box', 'aria-hidden': 'true' }, i.done ? '✓' : ''), h('span', { class: 'tx' }, i.text), by ? h('small', { class: 'by' }, by) : null);
  b.addEventListener('click', (e) => { e.stopPropagation(); tickItem(i); });
  if (!inCard) onHold(b, () => sheet(i.text, [
    ['✎ Edit', async () => { const t = prompt('Edit item', i.text); if (t?.trim() && t.trim() !== i.text) upsertList((await api(`/items/${i.id}`, { method: 'POST', body: { text: t } })).list); }],
    ['🗑 Delete', async () => upsertList((await api(`/items/${i.id}`, { method: 'DELETE' })).list), { danger: true }]]));
  return b;
}
async function tickItem(i) {
  i.done = !i.done; i.doneBy = state.me.id; redrawTogether();      // show it at once; the server's copy follows
  try { upsertList((await api(`/items/${i.id}`, { method: 'POST', body: { done: i.done } })).list); }
  catch (e) { i.done = !i.done; redrawTogether(); toast(e.message, true); }
}
function listMenu(l) {
  if (!l) return;
  const shared = tgConv(l.conv)?.kind !== 'bot';
  sheet(`${l.emoji || '📝'} ${l.title}`, [
    shared ? ['💬 Share in the chat', async () => { await api(`/lists/${l.id}/share`, { method: 'POST' }); go(`/c/${l.conv}`); }] : null,
    ['✎ Rename', async () => { const t = prompt('List name', l.title); if (t?.trim()) upsertList((await api(`/lists/${l.id}`, { method: 'POST', body: { title: t } })).list); }],
    [l.archived ? '📤 Unarchive' : '🗄 Archive', async () => { upsertList((await api(`/lists/${l.id}`, { method: 'POST', body: { archived: !l.archived } })).list); toast(l.archived ? 'Unarchived' : 'Archived'); }],
    ['🗑 Delete list', async () => {
      if (!confirm(`Delete "${l.title}" and its ${l.items.length} items for everyone?`)) return;
      await api(`/lists/${l.id}`, { method: 'DELETE' }); dropList(l.id); go('/together');
    }, { danger: true }],
  ]);
}

// A list shared into a chat: a live card; ticking it here ticks it everywhere.
function listCard(m) {
  const id = m.extra.list, l = tgList(id);
  if (l === undefined) {
    if (!listPending.has(id)) {
      listPending.add(id);
      api(`/lists/${id}`).then(({ list }) => upsertList(list)).catch(() => { listCache.set(id, null); redrawTogether(); }).finally(() => listPending.delete(id));
    }
    return h('div', { class: 'lcard' }, h('b', { class: 'lt' }, m.text), h('small', { class: 'soft' }, 'Loading…'));
  }
  if (!l) return h('div', { class: 'lcard' }, h('b', { class: 'lt' }, m.text), h('small', { class: 'soft' }, 'This list was deleted.'));
  const open = l.items.filter((i) => !i.done), shown = [...open, ...l.items.filter((i) => i.done)].slice(0, 8);
  const add = h('button', { type: 'button' }, '＋ Add');
  add.addEventListener('click', async (e) => {
    e.stopPropagation();
    const t = prompt(`Add to ${l.title} (one item per line)`);
    if (t?.trim()) upsertList((await api(`/lists/${id}/items`, { method: 'POST', body: { text: t } }).catch((x) => { toast(x.message, true); return {}; })).list || l);
  });
  const openB = h('button', { type: 'button', class: 'go' }, 'Open list');
  openB.addEventListener('click', (e) => { e.stopPropagation(); go(`/together/list/${id}`); });
  return h('div', { class: 'lcard' }, h('b', { class: 'lt' }, `${l.emoji || '📝'} ${l.title}`),
    h('small', { class: 'soft' }, l.items.length ? `${open.length} of ${l.items.length} left` : 'Empty so far'),
    h('div', { class: 'litems' }, shown.map((i) => itemRow(i, true))),
    l.items.length > shown.length ? h('small', { class: 'soft' }, `+${l.items.length - shown.length} more`) : null,
    h('div', { class: 'acts' }, openB, add));
}
// 📎 → List in a chat: share one of this chat's lists, or start a new one here.
async function chatList(c) {
  if (!state.tg) await loadTogether();
  const share = async (l) => { await api(`/lists/${l.id}/share`, { method: 'POST' }); };
  const mine = state.tg.lists.filter((l) => l.conv === c.id && !l.archived);
  sheet('Share a list here', [
    ...mine.map((l) => [`${l.emoji || '📝'} ${l.title}`, () => share(l)]),
    ['＋ New list for this chat', () => listForm({}, c.id, share)],
  ]);
}

// ----- calendar -----
function occurrences(e, from, to) {
  if (!e.repeat) return e.starts >= from && e.starts < to ? [e.starts] : [];
  const out = [];
  for (let t = e.starts, n = 0; t < to && n < 800; n++) {
    if (t >= from) out.push(t);
    const d = new Date(t);
    if (e.repeat === 'daily') d.setDate(d.getDate() + 1); else if (e.repeat === 'weekly') d.setDate(d.getDate() + 7); else d.setMonth(d.getMonth() + 1);
    t = d.getTime();
  }
  return out;
}
const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
function drawCal(box) {
  const now = new Date();
  const base = state.calMonth || (state.calMonth = new Date(now.getFullYear(), now.getMonth(), 1));
  const y = base.getFullYear(), mo = base.getMonth();
  const from = new Date(y, mo, 1).getTime(), to = new Date(y, mo + 1, 1).getTime();
  const byDay = new Map();
  for (const e of state.tg.events) for (const t of occurrences(e, from, to)) { const k = dayKey(t); if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push({ e, t }); }
  const nav = (step) => { const b = h('button', { type: 'button', 'aria-label': step < 0 ? 'Previous month' : 'Next month' }, step < 0 ? '‹' : '›'); b.addEventListener('click', () => { state.calMonth = new Date(y, mo + step, 1); state.calSel = null; drawTogether(); }); return b; };
  const todayB = h('button', { type: 'button', class: 'tdy' }, 'Today');
  todayB.addEventListener('click', () => { state.calMonth = null; state.calSel = null; drawTogether(); });
  const cells = [...'MTWTFSS'].map((c) => h('div', { class: 'hd', 'aria-hidden': 'true' }, c));
  for (let i = 0; i < (new Date(y, mo, 1).getDay() + 6) % 7; i++) cells.push(h('div', { class: 'blank' }));
  for (let d = 1; d <= new Date(y, mo + 1, 0).getDate(); d++) {
    const k = `${y}-${mo + 1}-${d}`, n = byDay.get(k)?.length || 0;
    const b = h('button', { type: 'button', class: ['cd', k === dayKey(now) && 'today', n && 'dot', state.calSel === k && 'sel'].filter(Boolean).join(' '),
      'aria-label': `${d} ${base.toLocaleDateString('en-IN', { month: 'long' })}${n ? `, ${n} event${n > 1 ? 's' : ''}` : ''}` }, String(d));
    b.addEventListener('click', () => { state.calSel = state.calSel === k ? null : k; drawTogether(); });
    cells.push(b);
  }
  while ((cells.length - 7) % 7) cells.push(h('div', { class: 'blank' }));
  const parts = [h('div', { class: 'cnav' }, nav(-1), h('b', {}, base.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })), todayB, nav(1)), h('div', { class: 'cal' }, cells)];
  if (state.calSel) {
    const [yy, mm, dd] = state.calSel.split('-').map(Number), day = new Date(yy, mm - 1, dd);
    const list = (byDay.get(state.calSel) || []).sort((a, b) => a.t - b.t);
    const add = h('button', { class: 'btn ghost tadd', type: 'button' }, '＋ Add on this day');
    add.addEventListener('click', () => eventForm({ date: state.calSel }));
    parts.push(h('div', { class: 'sec pad' }, day.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })),
      ...(list.length ? list.map(evRow) : [h('p', { class: 'soft pad' }, 'Nothing planned.')]), add);
  } else {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const soon = state.tg.events.flatMap((e) => occurrences(e, start, start + 62 * 86400e3).slice(0, 10).map((t) => ({ e, t }))).sort((a, b) => a.t - b.t).slice(0, 40);
    const add = h('button', { class: 'btn ghost tadd', type: 'button' }, '＋ Event or reminder');
    add.addEventListener('click', () => eventForm({}));
    parts.push(h('div', { class: 'sec pad' }, 'Coming up'),
      ...(soon.length ? soon.map(evRow) : [h('p', { class: 'soft pad' }, 'Nothing in the next two months.')]), add,
      h('p', { class: 'soft pad tip' }, 'Tip: type "remind us Sunday 10am call Mom" in your chat and it shows up here.'));
  }
  box.replaceChildren(...parts);
}
function evRow({ e, t }) {
  const past = t < Date.now() - (e.allDay ? 86400e3 : 3600e3);
  const who = !e.forAll ? 'just you' : tgConv(e.conv)?.kind === 'dm' ? 'both of you' : tgConv(e.conv)?.kind === 'bot' ? 'just you' : tgConv(e.conv)?.title;
  const r = h('button', { class: 'ev' + (past ? ' past' : ''), type: 'button' },
    h('div', { class: 'et' }, new Date(t).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }), h('small', {}, e.allDay ? 'all day' : time(t))),
    h('div', { class: 'ex' }, h('b', {}, e.remindAt != null ? '⏰ ' : '', e.title),
      h('small', {}, [e.kind === 'reminder' ? 'reminder' : null, who, EVERY[e.repeat], e.by !== state.me.id ? `added by ${nameOf(e.by)}` : null].filter(Boolean).join(' · '))));
  r.addEventListener('click', () => eventForm(e));
  return r;
}

const REMIND_OPTS = [['', 'No reminder'], ['0', 'At the time'], ['15', '15 minutes before'], ['60', '1 hour before'], ['1440', '1 day before']];
async function eventForm(ev = {}, opts = {}) {
  if (!state.tg) await loadTogether();
  const isNew = !ev.id, pad = (n) => String(n).padStart(2, '0');
  let start;
  if (ev.starts) start = new Date(ev.starts);
  else if (ev.date) { const [yy, mm, dd] = ev.date.split('-').map(Number); start = new Date(yy, mm - 1, dd, 10, 0); }
  else { start = new Date(Date.now() + 3600e3); start.setMinutes(0, 0, 0); }
  const kindR = ev.kind === 'reminder' || (isNew && opts.reminder);
  const title = h('input', { maxlength: '120', required: true, value: ev.title || '', placeholder: kindR ? 'e.g. Call Mom' : 'e.g. Dinner with Rahul and Priya', autocapitalize: 'sentences' });
  const date = h('input', { type: 'date', required: true, value: `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}` });
  const tm = h('input', { type: 'time', value: `${pad(start.getHours())}:${pad(start.getMinutes())}` });
  const allDay = h('input', { type: 'checkbox' }); allDay.checked = !!ev.allDay; tm.disabled = allDay.checked;
  const remind = h('select', { 'aria-label': 'Reminder' }, REMIND_OPTS.map(([v, l]) => h('option', { value: v }, l)));
  const lead = ev.remindAt == null ? '' : String(Math.round(((ev.allDay ? ev.starts + 9 * 3600e3 : ev.starts) - ev.remindAt) / 60e3));
  if (lead && !REMIND_OPTS.some(([v]) => v === lead)) remind.append(h('option', { value: lead }, `${lead} minutes before`));
  remind.value = isNew ? (kindR ? '0' : '60') : lead;
  const sync = () => { tm.disabled = allDay.checked; remind.options[1].textContent = allDay.checked ? 'On the day, 9:00 AM' : 'At the time'; remind.options[4].textContent = allDay.checked ? 'The day before, 9:00 AM' : '1 day before'; };
  allDay.addEventListener('change', sync); sync();
  const repeat = h('select', { 'aria-label': 'Repeat' }, [['', 'Does not repeat'], ['daily', 'Every day'], ['weekly', 'Every week'], ['monthly', 'Every month']].map(([v, l]) => h('option', { value: v }, l)));
  repeat.value = ev.repeat || '';
  const conv = convSelect(ev.conv || opts.conv);
  const who = h('select', { 'aria-label': 'Who gets it' }, h('option', { value: 'all' }, 'Everyone in the chat'), h('option', { value: 'me' }, 'Just me'));
  who.value = ev.forAll === false ? 'me' : 'all';
  const whoF = fld('Who sees it and gets the reminder', who);
  const syncWho = () => { whoF.hidden = tgConv(Number(conv.value))?.kind === 'bot'; };
  conv.addEventListener('change', syncWho); syncWho();
  let close;
  const del = isNew ? null : h('button', { class: 'btn ghost full tdel', type: 'button' }, 'Delete');
  del?.addEventListener('click', async () => {
    if (!confirm(`Delete "${ev.title}"${ev.forAll ? ' for everyone' : ''}?`)) return;
    try { await api(`/events/${ev.id}`, { method: 'DELETE' }); dropEvent(ev.id); close(); toast('Deleted'); } catch (e) { toast(e.message, true); }
  });
  close = formSheet(isNew ? (kindR ? 'New reminder' : 'New event') : 'Edit', [
    fld(kindR ? 'Remind about' : 'What', title),
    h('div', { class: 'trow' }, fld('Date', date), fld('Time', tm)),
    h('label', { class: 'tcheck' }, allDay, 'All day'),
    h('div', { class: 'trow' }, fld('Reminder', remind), fld('Repeat', repeat)),
    fld('Shared with', conv), whoF,
  ], isNew ? 'Save' : 'Save changes', async () => {
    const [Y, Mo, D] = date.value.split('-').map(Number), [hh, mm] = (tm.value || '09:00').split(':').map(Number);
    const starts = allDay.checked ? new Date(Y, Mo - 1, D).getTime() : new Date(Y, Mo - 1, D, hh, mm).getTime();
    const mins = remind.value === '' ? null : Number(remind.value);
    const at = mins == null ? null : (allDay.checked ? starts + 9 * 3600e3 : starts) - mins * 60e3;
    if (at != null && at < Date.now() - 60e3 && !repeat.value && !confirm('That reminder time has already passed, so no reminder will be sent. Save anyway?')) throw new Error('Pick a later time for the reminder.');
    const { event } = await api(isNew ? '/events' : `/events/${ev.id}`, { method: 'POST',
      body: { title: title.value, starts, allDay: allDay.checked, remind: mins, repeat: repeat.value || null, who: who.value, conv: Number(conv.value), kind: kindR ? 'reminder' : 'event' } });
    upsertEvent(event);
    toast(isNew ? (mins == null ? 'Saved' : `Saved. ${who.value === 'me' || whoF.hidden ? 'You\'ll' : 'Everyone will'} get a push.`) : 'Updated');
  }, del);
  if (isNew) setTimeout(() => title.focus(), 60);
}

render();
