// Tinker hub (Swiss Pro): one static page; the URL path picks which tool renders. All data is inserted
// as text (never as HTML), because notes and AI output come from outside. Styles are set through the
// CSSOM (el.style), which the strict Content-Security-Policy allows.
const view = document.getElementById('view');
const logoutBtn = document.querySelector('.logout');
const tabs = document.querySelector('.tabs');
const statusEl = document.getElementById('status');

// ---------- tiny helpers ----------
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}
const rupees = (n) => '₹' + Math.round(n).toLocaleString('en-IN');
const ist = () => new Date(Date.now() + 5.5 * 3600e3);
const today = () => ist().toISOString().slice(0, 10);
const monthName = (m) => new Date(m + '-01T00:00:00Z').toLocaleString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const shortMonth = (m) => new Date(m + '-01T00:00:00Z').toLocaleString('en-IN', { month: 'short', timeZone: 'UTC' });
const clip = (s, n) => (s && s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s || '');
const ago = (t) => { const d = (Date.now() - t) / 1000; return d < 90 ? 'just now' : d < 3600 ? `${Math.round(d / 60)} min ago` : d < 86400 ? `${Math.round(d / 3600)} h ago` : `${Math.round(d / 86400)} d ago`; };

let toastTimer;
function toast(msg, bad = false) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'toast' + (bad ? ' bad' : ''); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2800);
}

async function api(path, { method = 'GET', body } = {}) {
  const opts = {
    method, credentials: 'same-origin',
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Hub': '1' },
    body: body ? JSON.stringify(body) : undefined,
  };
  let r;
  try { r = await fetch('/api' + path, opts); }
  catch {
    // A dropped connection (Wi-Fi blip at home or on the phone): wait a moment and retry once.
    await new Promise((ok) => setTimeout(ok, 1500));
    try { r = await fetch('/api' + path, opts); }
    catch { throw new Error('Could not reach the phone. Check your connection, or the phone may be offline.'); }
  }
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/login') { go('/login'); throw new Error('Log in first.'); }
  if (!r.ok || data.error) throw new Error(data.error || `Error ${r.status}`);
  return data;
}

function busy(btn, fn) {
  return async (e) => {
    e?.preventDefault();
    if (btn) btn.disabled = true;
    try { await fn(); } catch (err) { toast(err.message, true); } finally { if (btn) btn.disabled = false; }
  };
}

// "250 swiggy dinner" -> { amount: 250, note: 'swiggy dinner' }
const parseQuick = (s) => { const m = /^\s*₹?\s*(\d+(?:\.\d+)?)\s*(.*)$/.exec(s || ''); return m ? { amount: Number(m[1]), note: m[2].trim() } : null; };
function quickAdd(placeholder, extra = () => ({})) {
  const input = h('input', { placeholder, 'aria-label': 'Amount and note', autocomplete: 'off', enterkeyhint: 'done' });
  const btn = h('button', { type: 'submit' }, 'Add');
  const form = h('form', { class: 'quick' }, input, btn);
  form.addEventListener('submit', busy(btn, async () => {
    const q = parseQuick(input.value);
    if (!q || !(q.amount > 0)) throw new Error('Start with the amount, e.g. "250 swiggy dinner".');
    const item = await api('/expenses', { method: 'POST', body: { ...q, ...extra() } });
    toast(`Logged ${rupees(item.amount)} · ${item.category}`);
    render();
  }));
  return form;
}

// ---------- live room updates (Server-Sent Events) ----------
let roomStream = null;
let pageTimer = null;                              // per-page refresh (health), cleared on every navigation
let jobsTimer = null;                              // /jobs live polling, cleared on every navigation
function liveRoom(onState) {
  roomStream?.close();
  roomStream = new EventSource('/api/room/stream');
  roomStream.addEventListener('room', (e) => { try { onState(JSON.parse(e.data)); } catch { /* ignore a bad frame */ } });
  // EventSource reconnects by itself; nothing else to do on error.
}

// ---------- phone status chip ----------
async function refreshStatus() {
  try {
    const s = await api('/status');
    const stale = s.updated && Date.now() - s.updated > 5 * 60e3;
    statusEl.classList.toggle('stale', !!stale);
    statusEl.querySelector('span').textContent =
      `S20 ${stale ? 'quiet' : 'online'}` + (s.battery != null ? ` · ${s.charging ? '⚡' : ''}${s.battery}%` : '') + (s.tempC != null ? ` · ${Math.round(s.tempC)}°C` : '');
    statusEl.hidden = false;
    return s;
  } catch { statusEl.hidden = true; return null; }
}
setInterval(() => { if (!statusEl.hidden) refreshStatus(); }, 60e3);
statusEl.setAttribute('role', 'link'); statusEl.setAttribute('tabindex', '0'); statusEl.title = 'Phone health';
statusEl.addEventListener('click', () => go('/health'));
statusEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') go('/health'); });

// ---------- pages ----------
const pages = {
  async '/'() {
    const month = today().slice(0, 7);
    const [exp, iv, ta, room, li, st, jb] = await Promise.allSettled([
      api(`/expenses?month=${month}`), api('/interview'), api('/tamil'), api('/room'), api('/linkedin'), refreshStatus(), api('/jobs'),
    ]).then((r) => r.map((x) => (x.status === 'fulfilled' ? x.value : null)));
    const hr = ist().getUTCHours();
    const greet = hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
    const dateLine = ist().toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
    const up = st?.upSince ? ` · served from a cupboard for ${ago(st.upSince).replace(' ago', '')}` : '';

    // Money
    const todaySpend = exp ? exp.items.filter((i) => i.date === today()).reduce((s, i) => s + i.amount, 0) : 0;
    const cats = exp ? Object.entries(exp.byCategory) : [];
    const money = h('a', { class: 'w', href: '/expenses', 'data-link': true },
      h('div', { class: 'label' }, h('span', {}, `Spent · ${shortMonth(month)}`)),
      h('div', { class: 'big' }, exp ? rupees(exp.total) : '—'),
      h('div', { class: 'sub' }, exp ? `today ${rupees(todaySpend)}${cats[0] ? ` · ${cats[0][0]} leads` : ''}` : 'unavailable'),
      cats.length ? h('div', { class: 'minibar' }, cats.slice(0, 6).map(([, v], i) => h('i', { class: 'k' + i, style: `width:${(v / exp.total) * 100}%` }))) : null);

    // Room (live)
    const roomBig = h('div', { class: 'big' }), roomSub = h('div', { class: 'sub' });
    const roomW = h('a', { class: 'w', href: '/room', 'data-link': true }, h('div', { class: 'label' }, h('span', {}, 'Room'), h('span', { class: 'live' }, 'live')), roomBig, roomSub);
    const paintRoom = (s, flash) => {
      roomBig.textContent = s?.lights ? s.lights.toUpperCase() : '—';
      roomSub.replaceChildren(s?.lux != null ? `${Math.round(s.lux)} lux · ` : '', s?.armed ? h('span', { class: 'accent' }, 'armed') : 'alerts off');
      if (flash) { roomW.classList.remove('flash'); void roomW.offsetWidth; roomW.classList.add('flash'); }
    };
    paintRoom(room?.state);
    liveRoom((s) => { const changed = s.lights !== room?.state?.lights; paintRoom(s, changed); if (room) room.state = s; });

    // Interview
    const q = iv?.today;
    const interview = h('div', { class: 'w wide' },
      h('div', { class: 'label' }, h('span', {}, 'Interview · today'), q ? h('span', {}, q.topic) : null),
      q ? h('div', { class: 'q' }, clip(q.question, 150)) : h('div', { class: 'q muted' }, 'No question yet today.'),
      h('div', { class: 'sub' }, q ? (q.score ? `Answered · ${q.score}/5` : 'Not answered yet') : 'A new one arrives at 9 AM'),
      h('a', { class: 'btn small', href: '/interview', 'data-link': true }, q ? (q.score ? 'See feedback' : 'Answer now') : "Get today's question"));

    // Tamil
    const p = ta?.today;
    const tamil = h('a', { class: 'w', href: '/tamil', 'data-link': true }, h('div', { class: 'label' }, h('span', {}, 'Tamil')),
      h('div', { class: 'q' }, p ? p.transliteration : 'Tap for today'), h('div', { class: 'sub' }, p ? clip(p.meaning, 60) : ta?.theme || ''));

    // LinkedIn
    const draft = li?.drafts?.find((d) => d.status === 'draft');
    const linkedin = h('a', { class: 'w', href: '/linkedin', 'data-link': true }, h('div', { class: 'label' }, h('span', {}, 'LinkedIn')),
      h('div', { class: 'big s' }, draft ? 'Draft ready' : 'Fri 7 PM'), h('div', { class: 'sub' }, draft ? `from ${draft.commits} commits` : 'next draft'));

    // Job agent
    const jobsW = h('a', { class: 'w', href: '/jobs', 'data-link': true },
      h('div', { class: 'label' }, h('span', {}, 'Job agent'), jb?.installed ? h('span', { class: jb.paused ? '' : 'live' }, jb.paused ? 'paused' : jb.dryRun ? 'dry run' : 'live') : null),
      h('div', { class: 'big' }, jb?.installed ? String(jb.today.applied) : '—'),
      h('div', { class: 'sub' }, jb?.installed ? `applied today · ${jb.total.applied} total${jb.questions.length ? ` · ${jb.questions.length} question${jb.questions.length > 1 ? 's' : ''} for you` : ''}` : 'not running'));

    // Phone health
    const hotPhone = st?.battC >= 43;
    const phoneW = h('a', { class: 'w', href: '/health', 'data-link': true },
      h('div', { class: 'label' }, h('span', {}, 'Phone'), hotPhone ? h('span', { class: 'accent' }, 'hot') : null),
      h('div', { class: 'big' + (hotPhone ? ' accent' : '') }, st?.tempC != null ? `${Math.round(st.tempC)}°C` : '—'),
      h('div', { class: 'sub' }, st ? `🔋${st.battery}%${st.charging ? ' ⚡' : ''}${st.availMB ? ` · ${(st.availMB / 1024).toFixed(1)} GB free` : ''}` : 'unavailable'));

    return [
      h('div', { class: 'hello' }, h('h1', {}, `${greet}, Guman`), h('p', { class: 'lede' }, dateLine + up)),
      h('div', { class: 'grid' }, money, roomW, jobsW, interview, tamil, linkedin, phoneW),
      quickAdd('250 swiggy dinner'),
    ];
  },

  async '/health'() {
    const box = h('div', {}, h('p', { class: 'loading' }, 'Measuring'));
    const svg = (tag, attrs) => { const e = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
    const gb = (mb) => `${(mb / 1024).toFixed(1)} GB`;
    const spark = (title, key, fmt, red) => {
      const pts = (lastHealth?.history || []).filter((x) => x[key] != null);
      if (pts.length < 2) return h('div', { class: 'spark-box' }, h('div', { class: 'label' }, h('span', {}, title)), h('p', { class: 'muted' }, 'Collecting: one point every 5 minutes.'));
      const vals = pts.map((x) => x[key]), lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
      const t0 = pts[0].t, t1 = pts[pts.length - 1].t || t0 + 1;
      const line = svg('polyline', { points: pts.map((x) => `${((x.t - t0) / (t1 - t0 || 1)) * 300},${56 - ((x[key] - lo) / span) * 52}`).join(' ') });
      const chart = svg('svg', { viewBox: '0 0 300 60', preserveAspectRatio: 'none', class: 'spark' + (red ? ' red' : ''), role: 'img', 'aria-label': `${title} over the last 24 hours` });
      chart.append(line);
      return h('div', { class: 'spark-box' }, h('div', { class: 'label' }, h('span', {}, title), h('span', {}, `now ${fmt(vals[vals.length - 1])} · low ${fmt(lo)} · high ${fmt(hi)}`)), chart);
    };
    let lastHealth = null;
    const paint = (d) => {
      lastHealth = d;
      const used = d.mem.totalMB - d.mem.availMB, cpu = d.services.reduce((n, x) => n + x.cpu, 0);
      const issues = [];
      if (d.battC >= 43) issues.push(`the battery is hot (${d.battC}°C)`);
      if (d.mem.availMB < 800) issues.push('memory is tight');
      if (d.disk.freeGB < 10) issues.push('storage is getting full');
      const tile = (label, big, sub, red) => h('div', { class: 'w' }, h('div', { class: 'label' }, h('span', {}, label)), h('div', { class: 'big' + (red ? ' accent' : '') }, big), h('div', { class: 'sub' }, sub));
      const maxMem = Math.max(...d.services.map((x) => x.memMB), 1);
      box.replaceChildren(
        h('div', { class: 'hello' }, h('h1', {}, 'Phone health'),
          h('p', { class: 'lede' }, issues.length ? h('span', { class: 'accent' }, `Needs attention: ${issues.join(', ')}.`) : 'All good: the phone is coping well.',
            ` · up ${ago(d.upSince).replace(' ago', '')} · ${(d.requests || 0).toLocaleString('en-IN')} requests today`)),
        h('div', { class: 'grid' },
          tile('Battery', d.battery != null ? `${d.battery}%` : '—', d.batteryStatus || ''),
          tile('CPU temp', d.cpuC != null ? `${Math.round(d.cpuC)}°C` : '—', 'safe below ~60°C', d.cpuC >= 60),
          tile('Battery temp', d.battC != null ? `${d.battC}°C` : '—', 'keep it below 43°C', d.battC >= 43),
          tile('CPU now', `${(cpu / 100).toFixed(1)}`, `of ${d.cores} cores busy`),
          tile('Memory free', gb(d.mem.availMB), `of ${gb(d.mem.totalMB)} · ${Math.round((used / d.mem.totalMB) * 100)}% used`, d.mem.availMB < 800),
          tile('Swap used', gb(d.mem.swapUsedMB), `of ${gb(d.mem.swapTotalMB)}`),
          tile('Storage free', `${Math.round(d.disk.freeGB)} GB`, `of ${Math.round(d.disk.totalGB)} GB`, d.disk.freeGB < 10),
          tile('Uptime', ago(d.upSince).replace(' ago', ''), 'without a restart')),
        h('div', { class: 'sec' }, "What's using the phone"),
        ...d.services.map((x) => h('div', { class: 'cat' },
          h('div', { class: 'l' }, h('span', {}, x.name), h('span', {}, `${x.memMB.toLocaleString('en-IN')} MB · ${x.cpu}% CPU`)),
          h('div', { class: 't' }, h('i', { class: x.cpu >= 100 ? 'over' : '', style: `width:${(x.memMB / maxMem) * 100}%` })))),
        h('p', { class: 'lede' }, 'Bar = memory. CPU is measured over one second; 100% means one full core (the phone has 8).'),
        h('div', { class: 'sec' }, 'Last 24 hours'),
        spark('CPU temperature', 'cpuC', (v) => `${Math.round(v)}°C`, false),
        spark('Battery temperature', 'battC', (v) => `${Math.round(v)}°C`, true),
        spark('Free memory', 'availMB', (v) => gb(v), false),
        h('div', { class: 'sec' }, 'Keep it healthy'),
        h('p', { class: 'lede' }, 'Turn on Settings → Battery → Protect battery (stops at 85%) and give the cupboard a little air. You get a push if the battery passes 43°C, memory drops under 600 MB or storage under 5 GB.'));
    };
    const load = async () => { try { paint(await api('/health')); } catch (e) { if (!lastHealth) box.replaceChildren(h('p', { class: 'err' }, e.message)); } };
    load();
    pageTimer = setInterval(load, 30e3);
    return [box];
  },

  async '/login'() {
    const me = await api('/me');
    if (me.loggedIn) return go('/');
    const pw = h('input', { type: 'password', name: 'password', autocomplete: 'current-password', required: true, placeholder: 'Password' });
    const err = h('p', { class: 'err' });
    const btn = h('button', { class: 'btn', type: 'submit' }, 'Log in');
    const form = h('form', { class: 'login' }, pw, btn, err);
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); btn.disabled = true; err.textContent = '';
      try { await api('/login', { method: 'POST', body: { password: pw.value } }); go('/'); }
      catch (x) { err.textContent = x.message; } finally { btn.disabled = false; }
    });
    return [h('h1', {}, 'Log in'), h('p', { class: 'lede' }, me.passwordSet ? 'Private tools. Owner only.' : 'No password set yet. Run set-password.sh from the Mac.'), form];
  },

  async '/expenses'() {
    const month = new URLSearchParams(location.search).get('month') || today().slice(0, 7);
    const d = await api(`/expenses?month=${month}`);
    const shift = (n) => { const [y, m] = month.split('-').map(Number); return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7); };
    const isNow = month === today().slice(0, 7);
    const days = isNow ? Number(today().slice(8, 10)) : new Date(Date.UTC(...month.split('-').map(Number), 0)).getUTCDate();

    const csv = h('button', { class: 'btn ghost small', type: 'button', style: 'margin:0' }, 'CSV ↓');
    csv.addEventListener('click', busy(csv, async () => {
      const r = await api(`/expenses/csv?month=${month}`);
      h('a', { href: URL.createObjectURL(new Blob([r.csv], { type: 'text/csv' })), download: r.filename }).click();
    }));

    const warn = d.categories.map((c) => [c, d.byCategory[c] || 0, d.budgets[c]]).filter(([, s, b]) => b && s >= b * 0.8)
      .sort((a, b) => b[1] / b[2] - a[1] / a[2])[0];
    const cat = h('select', { 'aria-label': 'Category' }, h('option', { value: '' }, 'Auto category'), d.categories.map((c) => h('option', { value: c }, c)));
    const date = h('input', { type: 'date', value: isNow ? today() : `${month}-01`, 'aria-label': 'Date' });

    const bars = d.categories.map((c) => {
      const spent = d.byCategory[c] || 0, b = d.budgets[c];
      if (!spent && !b) return null;
      const pct = Math.min(100, b ? (spent / b) * 100 : (spent / (d.total || 1)) * 100);
      return h('div', { class: 'cat' }, h('div', { class: 'l' }, h('span', {}, c), h('span', {}, b ? `${rupees(spent)} / ${rupees(b).slice(1)}` : rupees(spent))),
        h('div', { class: 't' }, h('i', { class: b && spent > b ? 'over' : '', style: `width:${pct}%` })));
    });
    const budgetForm = (() => {
      const c = h('select', { 'aria-label': 'Category' }, d.categories.map((x) => h('option', { value: x }, x)));
      const v = h('input', { type: 'number', min: '0', placeholder: 'Monthly budget (0 = none)', 'aria-label': 'Budget' });
      const b = h('button', { class: 'btn ghost', type: 'submit' }, 'Set');
      const f = h('form', { class: 'row' }, c, v, b);
      f.addEventListener('submit', busy(b, async () => { await api('/expenses/budget', { method: 'POST', body: { category: c.value, amount: v.value } }); toast('Budget saved'); render(); }));
      return h('details', {}, h('summary', {}, 'Set a budget'), f);
    })();

    const rows = d.items.map((i) => {
      const del = h('button', { class: 'x', title: 'Delete', type: 'button', 'aria-label': `Delete ${i.note}` }, '✕');
      del.addEventListener('click', busy(del, async () => {
        if (!confirm(`Delete ${rupees(i.amount)} ${i.note}?`)) return;
        await api(`/expenses/${i.id}`, { method: 'DELETE' }); toast('Deleted'); render();
      }));
      return h('div', { class: 'item' },
        h('div', { class: 'main' }, i.note || '—', h('span', { class: 'tag' }, i.category), h('small', {}, new Date(i.date + 'T00:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }))),
        h('span', { class: 'num' }, rupees(i.amount)), del);
    });

    return [
      h('div', { class: 'month' }, h('a', { href: `/expenses?month=${shift(-1)}`, 'data-link': true }, '‹ ' + shortMonth(shift(-1))),
        h('span', {}, monthName(month)), isNow ? null : h('a', { href: `/expenses?month=${shift(1)}`, 'data-link': true }, shortMonth(shift(1)) + ' ›'),
        h('span', { class: 'sp' }), csv),
      h('div', { class: 'hello' }, h('h1', {}, rupees(d.total)),
        h('p', { class: 'lede' }, `${d.items.length} entries · ${rupees(d.total / Math.max(1, days))} a day`,
          warn ? h('span', { class: 'accent' }, ` · ${warn[0]} at ${Math.round((warn[1] / warn[2]) * 100)}% of budget`) : '')),
      quickAdd('Amount and note, e.g. 180 uber', () => ({ category: cat.value, date: date.value })),
      h('details', {}, h('summary', {}, 'Category or date'), h('div', { class: 'row', style: 'display:flex;gap:.5rem;margin-top:.5rem;flex-wrap:wrap' }, cat, date)),
      h('div', { class: 'sec' }, 'By category'), ...(bars.some(Boolean) ? bars : [h('p', { class: 'muted' }, 'Nothing yet.')]), budgetForm,
      h('div', { class: 'sec' }, 'Entries'), rows.length ? h('div', { class: 'list' }, rows) : h('p', { class: 'muted' }, 'Nothing logged this month.'),
      h('p', { class: 'lede', style: 'margin-top:1.5rem' }, 'Also by Siri ("Log expense") or a text like "250 swiggy dinner" to your ntfy expense topic.'),
    ];
  },

  async '/interview'() {
    const d = await api('/interview');
    const q = d.today;
    const out = [h('div', { class: 'hello' }, h('h1', {}, 'Interview'), h('p', { class: 'lede' }, 'A question every morning at 9. Weak topics come back sooner.'))];
    if (!q) {
      const b = h('button', { class: 'btn', type: 'button' }, "Get today's question");
      b.addEventListener('click', busy(b, async () => { await api('/interview/new', { method: 'POST' }); render(); }));
      out.push(b);
    } else {
      out.push(h('div', { class: 'label' }, h('span', {}, q.topic)), h('div', { class: 'box q' }, q.question));
      if (q.score) {
        out.push(h('div', { class: 'score' }, `${q.score}/5`),
          h('div', { class: 'sec' }, 'What was good'), h('p', {}, q.good), h('div', { class: 'sec' }, 'Missing'), h('p', {}, q.missing),
          h('div', { class: 'sec' }, 'Model answer'), h('div', { class: 'box' }, q.model));
      } else {
        const ta = h('textarea', { placeholder: 'Type your answer as you would say it in the interview…' });
        const b = h('button', { class: 'btn', type: 'submit' }, 'Grade my answer');
        const f = h('form', {}, ta, h('div', { class: 'btns' }, b));
        f.addEventListener('submit', busy(b, async () => { await api('/interview/answer', { method: 'POST', body: { id: q.id, answer: ta.value } }); render(); }));
        out.push(f);
      }
    }
    if (d.topics.length) out.push(h('div', { class: 'sec' }, 'Topics · weakest first'),
      ...d.topics.map((t) => h('div', { class: 'cat' }, h('div', { class: 'l' }, h('span', {}, t.topic), h('span', {}, `${t.avg.toFixed(1)}/5 · ${t.n}×`)),
        h('div', { class: 't' }, h('i', { class: t.avg < 3 ? 'over' : '', style: `width:${(t.avg / 5) * 100}%` })))));
    const past = d.history.filter((x) => x.score && x.id !== q?.id);
    if (past.length) out.push(h('div', { class: 'sec' }, 'History'), h('div', { class: 'list' }, past.map((x) =>
      h('div', { class: 'item' }, h('div', { class: 'main' }, clip(x.question, 120), h('small', {}, `${x.date} · ${x.topic}`)), h('span', { class: 'num accent' }, `${x.score}/5`)))));
    return out;
  },

  async '/linkedin'() {
    const d = await api('/linkedin');
    const gen = h('button', { class: 'btn', type: 'button' }, 'Draft from this week');
    gen.addEventListener('click', busy(gen, async () => { await api('/linkedin/draft', { method: 'POST' }); toast('Draft ready'); render(); }));
    const drafts = d.drafts.map((x) => {
      const ta = h('textarea', {}, x.post);
      const set = (status, msg) => busy(null, async () => { await api('/linkedin/status', { method: 'POST', body: { id: x.id, status, post: ta.value } }); toast(msg); render(); });
      const copy = h('button', { class: 'btn', type: 'button' }, 'Approve & copy');
      copy.addEventListener('click', async () => { await navigator.clipboard.writeText(ta.value); await set('approved', 'Copied. Paste it into LinkedIn')(); });
      const skip = h('button', { class: 'btn ghost', type: 'button' }, 'Skip');
      skip.addEventListener('click', set('skipped', 'Skipped'));
      return h('div', { style: 'margin-bottom:2rem' },
        h('div', { class: 'label' }, h('span', {}, `${x.date} · ${x.commits} commits`), h('span', { class: x.status === 'draft' ? 'accent' : '' }, x.status)),
        h('div', { style: 'margin-top:.5rem' }, ta), x.status === 'draft' ? h('div', { class: 'btns' }, copy, skip) : null);
    });
    return [h('div', { class: 'hello' }, h('h1', {}, 'LinkedIn'),
      h('p', { class: 'lede' }, 'A draft every Friday at 7 PM from your commits. Nothing is posted automatically: approve, copy, paste into LinkedIn.')),
      h('div', { class: 'btns', style: 'margin-bottom:1.5rem' }, gen), ...(drafts.length ? drafts : [h('p', { class: 'muted' }, 'No drafts yet.')])];
  },

  async '/tamil'() {
    const d = await api('/tamil');
    const b = h('button', { class: 'btn ghost', type: 'button' }, d.today ? 'Another phrase' : "Get today's phrase");
    b.addEventListener('click', busy(b, async () => { await api('/tamil/new', { method: 'POST' }); render(); }));
    const t = d.today;
    const reply = t?.reply && (typeof t.reply === 'object'
      ? [t.reply.transliteration, t.reply.tamil && `(${t.reply.tamil})`, t.reply.meaning && `= ${t.reply.meaning}`].filter(Boolean).join(' ') : t.reply);
    return [
      h('div', { class: 'hello' }, h('h1', {}, 'Tamil'), h('p', { class: 'lede' }, `This week: ${d.theme}. A new phrase at 8 AM; quiz on Sundays.`)),
      t ? h('div', { class: 'box' }, h('div', { class: 'phrase' }, t.transliteration), h('div', { class: 'muted', style: 'font-size:1.15rem;margin:.25rem 0 .6rem' }, t.tamil),
        h('div', { style: 'font-weight:600' }, t.meaning), h('div', { class: 'muted', style: 'margin-top:.4rem' }, t.when),
        reply ? h('div', { style: 'margin-top:.6rem' }, h('span', { class: 'label' }, 'Reply '), reply) : null) : null,
      h('div', { class: 'btns' }, b),
      h('div', { class: 'sec' }, 'Earlier'),
      h('div', { class: 'list' }, d.phrases.filter((p) => p.date !== t?.date).map((p) =>
        h('div', { class: 'item' }, h('div', { class: 'main' }, h('b', {}, p.transliteration), h('small', {}, p.tamil)), h('span', { class: 'muted', style: 'text-align:right' }, p.meaning)))),
    ];
  },

  async '/jobs'() {
    const d = await api('/jobs');
    if (!d.installed) return [h('h1', {}, 'Jobs'), h('p', { class: 'lede' }, 'The job agent has not started on the phone yet.')];
    const params = new URLSearchParams(location.search);
    const filter = params.get('show') || 'matches';
    const term = params.get('q') || '';
    const act = (body, msg) => async () => { await api('/jobs/action', { method: 'POST', body }); toast(msg); render(); };
    const when = (t) => new Date(t).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

    // ---- live strip: what the agent is doing right now (polled every 5 s while this page is open)
    const nowText = h('span', {}), nowAgo = h('small', { class: 'muted' });
    const tiles = { applied: h('div', { class: 'big' }), found: h('div', { class: 'big' }), matched: h('div', { class: 'big' }), replies: h('div', { class: 'big' }) };
    const paint = (x) => {
      nowText.textContent = x.paused ? 'Paused' : x.now?.text || 'Idle';
      nowAgo.textContent = x.now?.at ? ` · ${ago(x.now.at)}` : '';
      for (const k of Object.keys(tiles)) tiles[k].textContent = x.today[k];
    };
    paint(d);
    jobsTimer = setInterval(async () => { try { paint(await api('/jobs')); } catch { /* next tick */ } }, 5000);

    const mode = h('div', { class: 'btns' },
      (() => { const b = h('button', { class: 'btn ghost small', type: 'button' }, d.paused ? 'Resume' : 'Pause');
        b.addEventListener('click', busy(b, act({ action: d.paused ? 'resume' : 'pause' }, d.paused ? 'Applying again' : 'Paused'))); return b; })(),
      (() => { const b = h('button', { class: 'btn small', type: 'button' }, d.dryRun ? 'Go live' : 'Back to dry run');
        b.addEventListener('click', busy(b, async () => {
          if (d.dryRun && !confirm('Go live? The agent will submit real applications for jobs scoring 75+, within the daily caps.')) return;
          await act({ action: d.dryRun ? 'live' : 'dry' }, d.dryRun ? 'Live: applications will be submitted' : 'Dry run: forms filled, never submitted')();
        })); return b; })());

    // ---- needs you: open questions (answer inline) + jobs to finish by hand
    const questions = d.questions.map((x) => {
      const input = h('input', { placeholder: 'Your answer', 'aria-label': `Answer to ${x.question}`, autocomplete: 'off' });
      const b = h('button', { type: 'submit' }, 'Save');
      const f = h('form', { class: 'quick', style: 'margin-top:.4rem' }, input, b);
      f.addEventListener('submit', busy(b, async () => {
        if (!input.value.trim()) throw new Error('Type an answer first.');
        await act({ action: 'answer', id: x.id, answer: input.value }, 'Saved. Remembered for every future application.')();
      }));
      return h('div', { class: 'item', style: 'display:block' }, h('div', { class: 'main' }, h('b', {}, `Q${x.id} `), x.question,
        x.waiting > 1 ? h('span', { class: 'tag red' }, `${x.waiting} waiting`) : null), f);
    });
    const attention = d.attention.map((j) => h('div', { class: 'item' },
      h('div', { class: 'main' }, h('a', { href: `/jobs/job?id=${encodeURIComponent(j.id)}`, 'data-link': true }, `${j.title} · ${j.company}`),
        h('span', { class: 'tag' + (j.status === 'interview' ? ' red' : '') }, j.status === 'manual' ? 'apply yourself' : j.status === 'claimed' ? 'you are applying' : j.status === 'captcha' ? 'captcha · finish on Mac' : j.status.replace('_', ' ')),
        h('small', {}, clip(j.status_note && !/\.png$/.test(j.status_note) ? j.status_note : j.location || '', 90))),
      j.score != null ? h('span', { class: 'num' }, `${j.score}%`) : null));

    // ---- 14-day applied chart
    const days = [...Array(14)].map((_, i) => new Date(Date.now() + 5.5 * 3600e3 - (13 - i) * 86400e3).toISOString().slice(0, 10));
    const per = Object.fromEntries(d.days.map((x) => [x.d, x.n]));
    const peak = Math.max(1, ...days.map((x) => per[x] || 0));
    const chart = h('div', { class: 'spark', role: 'img', 'aria-label': 'Applications per day, last 14 days' },
      days.map((x) => h('i', { title: `${x}: ${per[x] || 0}`, style: `height:${Math.max(3, ((per[x] || 0) / peak) * 100)}%` })));

    // ---- pipeline list with filters
    const FILTERS = [['matches', 'Scored'], ['queued', 'Queue'], ['ready', 'Dry-run ok'], ['applied', 'Applied'], ['interview', 'Interview'],
      ['captcha', 'CAPTCHA'], ['manual', 'Apply yourself'], ['claimed', 'Claimed'], ['needs_answer', 'Waiting on you'], ['rejected', 'Rejected'], ['all', 'All']];
    const list = await api(`/jobs/list?status=${filter}&q=${encodeURIComponent(term)}`);
    const search = h('input', { placeholder: 'Search title or company', value: term, 'aria-label': 'Search jobs' });
    const sform = h('form', { class: 'row' }, search);
    sform.addEventListener('submit', (e) => { e.preventDefault(); go(`/jobs?show=${filter}&q=${encodeURIComponent(search.value)}`); });
    const rows = list.jobs.map((j) => h('div', { class: 'item' },
      h('div', { class: 'main' }, h('a', { href: `/jobs/job?id=${encodeURIComponent(j.id)}`, 'data-link': true }, j.title),
        h('span', { class: 'tag' }, j.source), j.status !== filter ? h('span', { class: 'tag' }, j.status.replace('_', ' ')) : null,
        h('small', {}, `${j.company} · ${clip(j.location || '', 50)} · ${j.applied_at ? 'applied ' + ago(j.applied_at) : 'found ' + ago(j.found_at)}`)),
      h('span', { class: 'num' + (j.score >= 75 ? ' accent' : '') }, j.score != null ? `${j.score}%` : '—')));

    const learned = d.total.learned;
    return [
      h('div', { class: 'hello' }, h('h1', {}, 'Jobs'),
        h('p', { class: 'lede' }, h('span', { class: 'live' }, 'live'), ' ', nowText, nowAgo, ' · ', h('a', { href: '/jobs/live', 'data-link': true }, 'open terminal')),
        h('p', { class: 'lede' }, d.dryRun ? h('span', { class: 'accent' }, 'Dry run: forms are filled but never submitted. ') : `Live: applying to jobs scoring ${d.minScore || 65}+. `,
          `${d.total.found} jobs seen · ${d.total.applied} applied · ${d.total.interviews} in interview stage · ${learned} answers learned`)),
      mode,
      h('div', { class: 'grid', style: 'margin-top:1rem' },
        h('div', { class: 'w' }, h('div', { class: 'label' }, h('span', {}, 'Applied today')), tiles.applied),
        h('div', { class: 'w' }, h('div', { class: 'label' }, h('span', {}, 'Found today')), tiles.found),
        h('div', { class: 'w' }, h('div', { class: 'label' }, h('span', {}, `Matches ${d.minScore || 65}+`)), tiles.matched),
        h('div', { class: 'w' }, h('div', { class: 'label' }, h('span', {}, 'Replies')), tiles.replies)),
      h('div', { class: 'sec' }, 'Applied · last 14 days'), chart,
      questions.length || attention.length ? h('div', { class: 'sec' }, 'Needs you') : null,
      questions.length ? h('div', { class: 'list' }, questions) : null,
      attention.length ? h('div', { class: 'list', style: 'margin-top:.5rem' }, attention) : null,
      h('div', { class: 'sec' }, 'Pipeline'),
      h('div', { class: 'chips' }, FILTERS.map(([k, label]) => h('a', { href: `/jobs?show=${k}`, 'data-link': true, class: 'chip' + (k === filter ? ' on' : '') },
        label, d.byStatus[k] ? h('small', {}, ` ${d.byStatus[k]}`) : null))),
      sform,
      rows.length ? h('div', { class: 'list' }, rows) : h('p', { class: 'muted' }, 'Nothing here yet.'),
      h('div', { class: 'sec' }, 'Recruiter mail'),
      d.mail.length ? h('div', { class: 'list' }, d.mail.map((m) => h('div', { class: 'item' },
        h('div', { class: 'main' }, m.subject || '(no subject)', h('span', { class: 'tag' + (['interview', 'offer'].includes(m.category) ? ' red' : '') }, m.category),
          h('small', {}, `${m.from_addr} · ${when(m.at)}`))))) : h('p', { class: 'muted' }, 'No recruiter mail yet (or the mailbox is not connected).'),
      h('div', { class: 'sec' }, 'Activity'),
      d.events.length ? h('div', { class: 'list' }, d.events.map((e) => h('div', { class: 'item' },
        h('div', { class: 'main' }, e.text, h('small', {}, `${e.kind} · ${when(e.at)}`))))) : h('p', { class: 'muted' }, 'Nothing yet.'),
      h('div', { class: 'sec' }, 'Sources'),
      h('div', { class: 'list' }, d.bySource.map((s) => h('div', { class: 'item' }, h('div', { class: 'main' }, s.source), h('span', { class: 'num' }, `${s.applied || 0} / ${s.n}`)))),
      h('p', { class: 'lede', style: 'margin-top:1.5rem' }, h('a', { href: '/jobs/live', 'data-link': true }, 'Live terminal: what the phone is doing →')),
      h('p', { class: 'lede' }, h('a', { href: '/jobs/errors', 'data-link': true }, 'Errors: what failed and why →')),
      h('p', { class: 'lede' }, h('a', { href: '/jobs/memory', 'data-link': true }, 'What the agent knows about you →')),
    ];
  },

  async '/jobs/errors'() {
    const d = await api('/jobs/errors');
    const when = (t) => new Date(typeof t === 'number' ? t : Date.parse(t)).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    const evidence = (shot) => {
      if (!shot) return null;
      const box = h('div', {});
      const btn = (label, kind) => { const b = h('button', { class: 'btn ghost small', type: 'button', style: 'margin:.3rem .3rem 0 0' }, label);
        b.addEventListener('click', busy(b, async () => {
          const f = await api(`/jobs/evidence?kind=${kind}&shot=${encodeURIComponent(shot)}`);
          if (kind === 'png') box.replaceChildren(h('img', { src: `data:image/png;base64,${f.data}`, alt: 'Screenshot', style: 'max-width:100%;border:1px solid var(--line);margin-top:.5rem' }));
          else { const bytes = Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0)); h('a', { href: URL.createObjectURL(new Blob([bytes], { type: 'text/plain' })), download: f.name.replace(/\.html$/, '.txt') }).click(); }
        })); return b; };
      return h('div', {}, btn('Screenshot', 'png'), btn('Page HTML ↓', 'html'), box);
    };
    return [
      h('p', { class: 'lede' }, h('a', { href: '/jobs', 'data-link': true }, '‹ Jobs')),
      h('div', { class: 'hello' }, h('h1', {}, 'Errors'),
        h('p', { class: 'lede' }, `${d.total} errors in the last 7 days · last 24 h: ${d.attempts24h} application attempts, ${d.applied24h} applied`)),
      h('div', { class: 'sec' }, 'By type · newest first'),
      d.groups.length ? h('div', { class: 'list' }, d.groups.map((g) => h('div', { class: 'item', style: 'display:block' },
        h('div', { class: 'main' }, h('b', {}, `${g.count}× `), `${g.last.kind}: ${clip(g.last.message, 220)}`,
          h('span', { class: 'tag' + (g.lastHour ? ' red' : '') }, g.last.src), g.lastHour ? h('span', { class: 'tag red' }, `${g.lastHour} in the last hour`) : null,
          h('small', {}, `last ${when(g.last.at)} · first ${when(g.first)}${g.last.ctx?.job ? ` · job ${g.last.ctx.job}` : ''}`)),
        g.last.stack ? h('details', {}, h('summary', {}, 'Stack trace'), h('pre', { class: 'term', style: 'height:auto;max-height:18rem' }, g.last.stack)) : null))) : h('p', { class: 'muted' }, 'No errors recorded. 🎉'),
      h('div', { class: 'sec' }, 'Recent attempts that did not apply'),
      d.attempts.length ? h('div', { class: 'list' }, d.attempts.map((a) => h('div', { class: 'item', style: 'display:block' },
        h('div', { class: 'main' }, h('a', { href: `/jobs/job?id=${encodeURIComponent(a.job_id)}`, 'data-link': true }, `${a.title || a.job_id}${a.company ? ` · ${a.company}` : ''}`),
          h('span', { class: 'tag' }, a.status), h('small', {}, `${when(a.at)} · ${Math.round((a.ms || 0) / 1000)} s${a.filled != null ? ` · filled ${a.filled}` : ''}${a.unknown ? ` · ${a.unknown} unanswered` : ''}${a.reason ? ` · ${clip(a.reason, 160)}` : ''}`)),
        evidence(a.shot)))) : h('p', { class: 'muted' }, 'None yet.'),
    ];
  },

  async '/jobs/live'() {
    const term = h('div', { class: 'term', role: 'log', 'aria-live': 'off' });
    const screenImg = h('img', { class: 'screen', alt: "Live view of the phone's browser" });
    const screenCap = h('p', { class: 'muted', style: 'font-size:.8rem;margin:.4rem 0 0' }, 'Waiting for the phone…');
    let shotAt = 0;
    const paintScreen = async () => {
      const r = await api(`/jobs/screen?since=${shotAt}`);
      if (!r.working) { screenImg.hidden = true; screenCap.textContent = 'The browser is idle right now: it shows up here whenever the agent is searching or applying.'; return; }
      if (r.image) { screenImg.src = `data:image/jpeg;base64,${r.image}`; shotAt = r.shotAt; }
      screenImg.hidden = false;
      const task = String(r.task || '').replace(/^apply_/, 'applying via ').replace(/_/g, ' ');
      screenCap.textContent = `${task} · ${String(r.url || '').replace(/^https?:\/\//, '').slice(0, 90)} · ${ago(r.at)}`;
    };
    const now = h('span', {}), stat = { searches: h('div', { class: 'big' }), boards: h('div', { class: 'big' }), found: h('div', { class: 'big' }), applied: h('div', { class: 'big' }) };
    let offset = null;
    const time = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? new Date(t).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''; };
    const add = (lines) => {
      const stick = term.scrollTop + term.clientHeight >= term.scrollHeight - 30;
      for (const l of lines) {
        const msg = l.slice(25);
        const cls = /applied|"status":"applied"|✅|done:/i.test(msg) ? 'ok' : /error|failed|timeout|closed/i.test(msg) ? 'bad' : /^🌐/.test(msg) ? 'web' : '';
        term.append(h('div', { class: cls }, h('i', {}, time(l.slice(0, 24)) + '  '), msg));
      }
      while (term.childNodes.length > 600) term.firstChild.remove();
      if (stick) term.scrollTop = term.scrollHeight;
    };
    const tick = async () => {
      const [log, st] = await Promise.all([api(`/jobs/log${offset == null ? '' : `?since=${offset}`}`), api('/jobs')]);
      offset = log.offset; add(log.lines);
      stat.searches.textContent = log.searchesToday; stat.boards.textContent = log.boardsToday;
      stat.found.textContent = st.today.found; stat.applied.textContent = st.today.applied;
      now.textContent = st.paused ? 'Paused' : st.now?.text || 'Idle';
    };
    await tick();
    await paintScreen().catch(() => {});
    jobsTimer = setInterval(() => { tick().catch(() => {}); paintScreen().catch(() => {}); }, 3000);
    const tile = (label, el) => h('div', { class: 'w' }, h('div', { class: 'label' }, h('span', {}, label)), el);
    return [
      h('p', { class: 'lede' }, h('a', { href: '/jobs', 'data-link': true }, '‹ Jobs')),
      h('div', { class: 'hello' }, h('h1', {}, 'Live'), h('p', { class: 'lede' }, h('span', { class: 'live' }, 'now'), ' ', now)),
      h('div', { class: 'grid' }, tile('Searches today', stat.searches), tile('Sources today', stat.boards), tile('Jobs found today', stat.found), tile('Applied today', stat.applied)),
      h('div', { class: 'sec' }, "Phone's browser · live"), screenImg, screenCap,
      h('div', { class: 'sec' }, 'What the phone is doing'), term,
    ];
  },

  async '/jobs/job'() {
    const id = new URLSearchParams(location.search).get('id');
    const j = await api(`/jobs/detail?id=${encodeURIComponent(id)}`);
    const act = (action, msg) => busy(null, async () => { await api('/jobs/action', { method: 'POST', body: { action, id: j.id } }); toast(msg); render(); });
    const file = (kind) => busy(null, async () => {
      const f = await api(`/jobs/file?id=${encodeURIComponent(j.id)}&kind=${kind}`);
      const bytes = Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: f.type }));
      if (kind === 'resume') h('a', { href: url, download: f.name }).click();
      else shot.replaceChildren(h('img', { src: `data:${f.type};base64,${f.data}`, alt: 'Screenshot of the application', style: 'max-width:100%;border:1px solid var(--line)' }));
    });
    const shot = h('div', {});
    const btn = (label, fn, ghost = true) => { const b = h('button', { class: 'btn' + (ghost ? ' ghost' : ''), type: 'button' }, label); b.addEventListener('click', fn); return b; };
    return [
      h('p', { class: 'lede' }, h('a', { href: '/jobs', 'data-link': true }, '‹ Jobs')),
      h('div', { class: 'hello' }, h('h1', { style: 'font-size:clamp(1.6rem,4vw,2.4rem)' }, j.title),
        h('p', { class: 'lede' }, `${j.company} · ${j.location || ''} · ${j.source} · ${j.status.replace('_', ' ')}${j.applied_at ? ' · applied ' + ago(j.applied_at) : ''}`)),
      j.score != null ? h('div', {}, h('span', { class: 'score' }, `${j.score}%`), h('p', { class: 'muted' }, j.score_reasons)) : null,
      h('div', { class: 'btns' },
        h('a', { class: 'btn', href: j.apply_url || j.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open job ↗'),
        j.hasResume ? btn('Tailored resume ↓', file('resume')) : null,
        j.hasShot ? btn('Screenshot', file('shot')) : null,
        !['applied', 'interview', 'claimed', 'applying'].includes(j.status) ? btn("I'm applying", act('claim', 'Claimed: the agent will leave this one to you')) : null,
        !['applied', 'interview', 'queued'].includes(j.status) ? btn(j.status === 'claimed' ? 'Hand back to agent' : 'Apply anyway', act('queue', 'Queued')) : null,
        ['manual', 'claimed'].includes(j.status) ? btn('I applied', act('applied', 'Marked as applied')) : null,
        !['applied', 'interview', 'skipped'].includes(j.status) ? btn('Skip', act('skip', 'Skipped')) : null),
      shot,
      j.status_note && !/\.png$/.test(j.status_note) ? h('p', { class: 'muted' }, j.status_note) : null,
      ...(() => {
        // Every answer the agent prepared for this application, ready to copy into the form.
        const fa = (() => { try { return JSON.parse(j.form_answers || 'null'); } catch { return null; } })();
        if (!fa) return [];
        const copy = (text) => async () => { await navigator.clipboard.writeText(text); toast('Copied'); };
        return [h('div', { class: 'sec' }, 'Prefilled answers for this form'),
          h('div', { class: 'list' }, fa.filled.map((f) => {
            const b = h('button', { class: 'btn ghost small', type: 'button', style: 'margin:0' }, 'Copy');
            b.addEventListener('click', copy(f.value));
            return h('div', { class: 'item' }, h('div', { class: 'main' }, f.label, h('small', {}, clip(f.value, 160))), b);
          })),
          fa.open.length ? h('p', { class: 'muted' }, `Not answered yet: ${fa.open.join(' · ')}`) : null];
      })(),
      j.emails.length ? h('div', { class: 'sec' }, 'Emails') : null,
      ...j.emails.map((m) => h('div', { class: 'box' }, h('div', { class: 'label' }, h('span', {}, `${m.direction === 'in' ? 'From ' + m.from_addr : 'You replied'} · ${m.category}`)),
        h('b', {}, m.subject), '\n\n', clip(m.body, 1500))),
      h('div', { class: 'sec' }, 'Description'), h('div', { class: 'box', style: 'border-left-color:var(--line);font-size:.88rem' }, j.description || '—'),
    ];
  },

  async '/jobs/memory'() {
    const d = await api('/jobs/memory');
    return [
      h('p', { class: 'lede' }, h('a', { href: '/jobs', 'data-link': true }, '‹ Jobs')),
      h('div', { class: 'hello' }, h('h1', {}, 'Memory'), h('p', { class: 'lede' }, 'Every question the agent has answered for you. "derived" ones came from your resume; forget any that look wrong and it will ask you next time.')),
      h('div', { class: 'list' }, d.answers.map((a) => {
        const x = h('button', { class: 'x', type: 'button', title: 'Forget', 'aria-label': `Forget ${a.question}` }, '✕');
        x.addEventListener('click', busy(x, async () => { if (!confirm(`Forget the answer to "${a.question}"?`)) return; await api('/jobs/action', { method: 'POST', body: { action: 'forget', id: a.id } }); toast('Forgotten'); render(); }));
        return h('div', { class: 'item' }, h('div', { class: 'main' }, a.question, h('small', {}, `${a.answer} · ${a.source}${a.uses ? ` · used ${a.uses}×` : ''}`)), x);
      })),
    ];
  },

  async '/room'() {
    const d = await api('/room');
    let s = d.state || {};
    const time = (t) => new Date(t).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    const lights = h('div', { class: 'big' }), lux = h('div', { class: 'big' }), alerts = h('div', { class: 'big' });
    const lightW = h('div', { class: 'w' }, h('div', { class: 'label' }, h('span', {}, 'Lights'), h('span', { class: 'live' }, 'live')), lights);
    const toggle = h('button', { class: 'btn', type: 'button' });
    const list = h('div', { class: 'list' });
    const paint = (events, flash) => {
      lights.textContent = s.lights ? s.lights.toUpperCase() : '—';
      lux.textContent = s.lux == null ? '—' : Math.round(s.lux);
      alerts.replaceChildren(s.armed ? h('span', { class: 'accent' }, 'Armed') : 'Off');
      toggle.textContent = s.armed ? "Disarm (I'm home)" : "Arm (I'm leaving)";
      if (events) list.replaceChildren(...events.map((e) => h('div', { class: 'item' }, h('div', { class: 'main' }, `${e.kind} ${e.value}`, e.armed ? h('span', { class: 'tag red' }, 'armed') : null), h('span', { class: 'muted' }, time(e.t)))));
      if (flash) { lightW.classList.remove('flash'); void lightW.offsetWidth; lightW.classList.add('flash'); }
    };
    toggle.addEventListener('click', busy(toggle, async () => { await api('/room/arm', { method: 'POST', body: { armed: !s.armed } }); toast(s.armed ? 'Disarming…' : 'Arming…'); }));
    paint(d.events);
    liveRoom((n) => { const changed = n.lights !== s.lights; s = n; paint(n.events, changed); });
    return [
      h('div', { class: 'hello' }, h('h1', {}, 'Room'), h('p', { class: 'lede' }, 'Live from the phone\'s light sensor. Alerts are pushed only while armed.')),
      h('div', { class: 'grid' }, lightW, h('div', { class: 'w' }, h('div', { class: 'label' }, h('span', {}, 'Lux now')), lux),
        h('div', { class: 'w' }, h('div', { class: 'label' }, h('span', {}, 'Alerts')), alerts)),
      h('div', { class: 'btns', style: 'margin-top:1rem' }, toggle),
      h('div', { class: 'sec' }, 'Recent changes'), list,
    ];
  },
};

// ---------- router ----------
const TITLES = { '/health': 'Phone health', '/jobs/live': 'Live', '/jobs': 'Jobs', '/jobs/job': 'Job', '/jobs/memory': 'Memory', '/': 'Tinker hub', '/login': 'Log in', '/expenses': 'Money', '/interview': 'Interview', '/linkedin': 'LinkedIn', '/tamil': 'Tamil', '/room': 'Room' };
function go(path) { history.pushState(null, '', path); render(); }
async function render() {
  const path = location.pathname.replace(/\/+$/, '') || '/';
  roomStream?.close(); roomStream = null;
  clearInterval(jobsTimer); jobsTimer = null;
  clearInterval(pageTimer); pageTimer = null;
  const inside = path !== '/login';
  tabs.hidden = !inside; logoutBtn.hidden = !inside;
  if (!inside) statusEl.hidden = true;
  tabs.querySelectorAll('a').forEach((a) => {
    if (a.getAttribute('href') === path || (path.startsWith('/jobs') && a.getAttribute('href') === '/jobs')) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  document.title = path === '/' ? 'Tinker hub' : `${TITLES[path] || 'Not found'} · Tinker hub`;
  if (!view.firstChild) view.replaceChildren(h('p', { class: 'loading' }, 'Loading'));
  const page = pages[path] || (async () => [h('h1', {}, 'Not found'), h('p', {}, h('a', { href: '/', 'data-link': true }, 'Back to the hub'))]);
  try {
    const nodes = await page();
    if (nodes) view.replaceChildren(...[nodes].flat().filter((n) => n != null && n !== false));
    if (inside && path !== '/' && statusEl.hidden) refreshStatus();
  } catch (e) {
    if (location.pathname !== '/login') view.replaceChildren(h('p', { class: 'err' }, e.message));
  }
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (a && a.origin === location.origin && !e.metaKey && !e.ctrlKey) { e.preventDefault(); if (a.pathname + a.search !== location.pathname + location.search) { view.replaceChildren(); go(a.pathname + a.search); } }
});
logoutBtn.addEventListener('click', async () => { await api('/logout', { method: 'POST' }).catch(() => {}); go('/login'); });
window.addEventListener('popstate', () => { view.replaceChildren(); render(); });
render();
