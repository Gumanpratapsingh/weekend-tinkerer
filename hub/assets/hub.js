// Tinker hub: one static page; the URL path picks which tool renders. All data is inserted as
// text (never as HTML), because notes and AI output come from outside.
const view = document.getElementById('view');
const logoutBtn = document.querySelector('.logout');

// ---------- tiny helpers ----------
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}
const rupees = (n) => '₹' + Math.round(n).toLocaleString('en-IN');
const today = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);

async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch('/api' + path, {
    method, credentials: 'same-origin',
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Hub': '1' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/login') { go('/login'); throw new Error('Log in first.'); }
  if (!r.ok || data.error) throw new Error(data.error || `Error ${r.status}`);
  return data;
}

function busy(btn, fn) {
  return async (e) => {
    e?.preventDefault();
    if (btn) btn.disabled = true;
    try { await fn(); } catch (err) { alert(err.message); } finally { if (btn) btn.disabled = false; }
  };
}

// ---------- pages ----------
const pages = {
  async '/'() {
    return [
      h('h1', {}, 'Tinker hub'),
      h('p', { class: 'lede' }, 'Weekend-tinkerer tools, served from a Galaxy S20 FE in a cupboard.'),
      h('div', { class: 'grid' },
        [['/expenses', 'Expenses', 'Spending by category, budgets, CSV export'],
          ['/interview', 'Interview coach', "Today's question, graded answers, weak topics"],
          ['/linkedin', 'LinkedIn drafts', "Friday drafts from the week's commits"],
          ['/tamil', 'Tamil phrase', 'Phrase of the day for Chennai life'],
          ['/room', 'Room', 'Lights on/off log, arm and disarm']]
          .map(([href, t, d]) => h('a', { class: 'card', href, 'data-link': true }, h('b', {}, t), h('span', {}, d)))),
    ];
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
    return [h('h1', {}, 'Log in'), me.passwordSet ? h('p', { class: 'lede' }, 'Private tools. Owner only.')
      : h('p', { class: 'lede' }, 'No password set yet. Run set-password.sh from the Mac.'), form];
  },

  async '/expenses'() {
    const month = new URLSearchParams(location.search).get('month') || today().slice(0, 7);
    const d = await api(`/expenses?month=${month}`);
    const amount = h('input', { type: 'number', min: '1', step: '0.01', placeholder: 'Amount', required: true, style: 'width:8rem' });
    const note = h('input', { placeholder: 'What for? (e.g. swiggy dinner)', style: 'flex:1 1 14rem' });
    const cat = h('select', {}, h('option', { value: '' }, 'Auto category'), d.categories.map((c) => h('option', { value: c }, c)));
    const date = h('input', { type: 'date', value: today() });
    const add = h('button', { class: 'btn', type: 'submit' }, 'Add');
    const form = h('form', { class: 'row' }, amount, note, cat, date, add);
    form.addEventListener('submit', busy(add, async () => {
      await api('/expenses', { method: 'POST', body: { amount: amount.value, note: note.value, category: cat.value, date: date.value } });
      render();
    }));
    const shift = (n) => { const [y, m] = month.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1 + n, 1)); return t.toISOString().slice(0, 7); };
    const csv = h('button', { class: 'btn ghost', type: 'button' }, 'Export CSV');
    csv.addEventListener('click', busy(csv, async () => {
      const r = await api(`/expenses/csv?month=${month}`);
      const a = h('a', { href: URL.createObjectURL(new Blob([r.csv], { type: 'text/csv' })), download: r.filename });
      a.click();
    }));
    const budgets = d.categories.map((c) => {
      const spent = d.byCategory[c] || 0, b = d.budgets[c];
      if (!spent && !b) return null;
      return h('div', {}, h('div', {}, h('b', {}, c), ' ', rupees(spent), b ? h('span', { class: 'muted' }, ` of ${rupees(b)}`) : ''),
        h('div', { class: 'bar' }, h('i', { class: b && spent > b ? 'over' : '', style: `width:${Math.min(100, b ? spent / b * 100 : spent / (d.total || 1) * 100)}%` })));
    });
    const budgetForm = (() => {
      const c = h('select', {}, d.categories.map((x) => h('option', { value: x }, x)));
      const v = h('input', { type: 'number', min: '0', placeholder: 'Monthly budget (0 = none)', style: 'width:14rem' });
      const b = h('button', { class: 'btn ghost', type: 'submit' }, 'Set budget');
      const f = h('form', { class: 'row' }, c, v, b);
      f.addEventListener('submit', busy(b, async () => { await api('/expenses/budget', { method: 'POST', body: { category: c.value, amount: v.value } }); render(); }));
      return f;
    })();
    const rows = d.items.map((i) => {
      const del = h('button', { class: 'x', title: 'Delete', type: 'button' }, '✕');
      del.addEventListener('click', busy(del, async () => { if (confirm(`Delete ${rupees(i.amount)} ${i.note}?`)) { await api(`/expenses/${i.id}`, { method: 'DELETE' }); render(); } }));
      return h('tr', {}, h('td', { class: 'hide' }, i.date.slice(5)), h('td', {}, i.note || '—'), h('td', {}, h('span', { class: 'tag' }, i.category)), h('td', { class: 'num' }, rupees(i.amount)), h('td', {}, del));
    });
    return [
      h('h1', {}, 'Expenses'),
      h('p', { class: 'lede' }, 'Log by Siri ("Log expense") or send "250 swiggy dinner" to your ntfy expense topic.'),
      h('div', { class: 'row', style: 'display:flex;gap:1rem;align-items:center;margin-bottom:1rem' },
        h('a', { href: `/expenses?month=${shift(-1)}`, 'data-link': true }, '← ' + shift(-1)), h('b', {}, month),
        month < today().slice(0, 7) ? h('a', { href: `/expenses?month=${shift(1)}`, 'data-link': true }, shift(1) + ' →') : null, csv),
      h('div', { class: 'stats' }, h('div', { class: 'stat' }, h('b', {}, rupees(d.total)), h('span', {}, `Total · ${d.items.length} entries`)),
        ...Object.entries(d.byCategory).slice(0, 3).map(([c, v]) => h('div', { class: 'stat' }, h('b', {}, rupees(v)), h('span', {}, c)))),
      form,
      h('h2', {}, 'By category'), ...budgets, budgetForm,
      h('h2', {}, 'Entries'), rows.length ? h('table', {}, h('tbody', {}, rows)) : h('p', { class: 'muted' }, 'Nothing logged this month.'),
    ];
  },

  async '/interview'() {
    const d = await api('/interview');
    const q = d.today;
    const out = [h('h1', {}, 'Interview coach'), h('p', { class: 'lede' }, 'A question every morning at 9. Weak topics come back sooner.')];
    if (!q) {
      const b = h('button', { class: 'btn', type: 'button' }, "Get today's question");
      b.addEventListener('click', busy(b, async () => { await api('/interview/new', { method: 'POST' }); render(); }));
      out.push(b);
    } else {
      out.push(h('p', {}, h('span', { class: 'tag' }, q.topic)), h('div', { class: 'box' }, q.question));
      if (q.score) {
        out.push(h('p', {}, 'Score ', h('span', { class: 'score' }, `${q.score}/5`)),
          h('h2', {}, 'What was good'), h('p', {}, q.good), h('h2', {}, 'Missing'), h('p', {}, q.missing),
          h('h2', {}, 'Model answer'), h('div', { class: 'box' }, q.model));
      } else {
        const ta = h('textarea', { placeholder: 'Type your answer as you would say it in the interview…' });
        const b = h('button', { class: 'btn', type: 'submit' }, 'Grade my answer');
        const f = h('form', {}, ta, h('p', {}, b));
        f.addEventListener('submit', busy(b, async () => { await api('/interview/answer', { method: 'POST', body: { id: q.id, answer: ta.value } }); render(); }));
        out.push(f);
      }
    }
    if (d.topics.length) out.push(h('h2', {}, 'Topics (weakest first)'),
      h('table', {}, h('tbody', {}, d.topics.map((t) => h('tr', {}, h('td', {}, t.topic), h('td', { class: 'num' }, `${t.avg.toFixed(1)}/5`), h('td', { class: 'num muted' }, `${t.n}×`))))));
    const past = d.history.filter((x) => x.score && x.id !== q?.id);
    if (past.length) out.push(h('h2', {}, 'History'), h('table', {}, h('tbody', {}, past.map((x) =>
      h('tr', {}, h('td', { class: 'hide' }, x.date.slice(5)), h('td', {}, x.question), h('td', { class: 'num score' }, `${x.score}/5`))))));
    return out;
  },

  async '/linkedin'() {
    const d = await api('/linkedin');
    const gen = h('button', { class: 'btn', type: 'button' }, 'Draft from this week');
    gen.addEventListener('click', busy(gen, async () => { const r = await api('/linkedin/draft', { method: 'POST' }); if (r.error) alert(r.error); render(); }));
    const drafts = d.drafts.map((x) => {
      const ta = h('textarea', {}, x.post);
      const set = (status) => busy(null, async () => { await api('/linkedin/status', { method: 'POST', body: { id: x.id, status, post: ta.value } }); render(); });
      const copy = h('button', { class: 'btn', type: 'button' }, 'Approve & copy');
      copy.addEventListener('click', async () => { await navigator.clipboard.writeText(ta.value); await set('approved')(); });
      const skip = h('button', { class: 'btn ghost', type: 'button' }, 'Skip');
      skip.addEventListener('click', set('skipped'));
      return h('div', { style: 'margin-bottom:2rem' }, h('p', {}, h('span', { class: 'tag' }, x.status), h('span', { class: 'muted' }, `${x.date} · from ${x.commits} commits`)),
        ta, x.status === 'draft' ? h('p', { style: 'display:flex;gap:.5rem' }, copy, skip) : null);
    });
    return [h('h1', {}, 'LinkedIn drafts'),
      h('p', { class: 'lede' }, 'A draft every Friday at 7 PM from your commits. Nothing is posted automatically: approve, copy, paste into LinkedIn.'),
      h('p', {}, gen), ...(drafts.length ? drafts : [h('p', { class: 'muted' }, 'No drafts yet.')])];
  },

  async '/tamil'() {
    const d = await api('/tamil');
    const b = h('button', { class: 'btn ghost', type: 'button' }, d.today ? 'Another phrase' : "Get today's phrase");
    b.addEventListener('click', busy(b, async () => { await api('/tamil/new', { method: 'POST' }); render(); }));
    const card = (p) => h('div', { class: 'box' }, h('b', { style: 'font-size:1.4rem' }, p.tamil), '\n', h('b', {}, p.transliteration), ` = ${p.meaning}\n`,
      h('span', { class: 'muted' }, p.when), p.reply ? `\nReply: ${p.reply}` : '');
    return [h('h1', {}, 'Tamil phrase'), h('p', { class: 'lede' }, `This week: ${d.theme}. A new phrase every morning at 8; quiz on Sundays.`),
      d.today ? card(d.today) : null, h('p', {}, b),
      h('h2', {}, 'Earlier'), h('table', {}, h('tbody', {}, d.phrases.filter((p) => p !== d.today && p.date !== d.today?.date).map((p) =>
        h('tr', {}, h('td', {}, h('b', {}, p.transliteration), h('br'), h('span', { class: 'muted' }, p.tamil)), h('td', {}, p.meaning)))))];
  },

  async '/room'() {
    const d = await api('/room');
    const s = d.state || {};
    const toggle = h('button', { class: 'btn', type: 'button' }, s.armed ? 'Disarm (I\'m home)' : 'Arm (I\'m leaving)');
    toggle.addEventListener('click', busy(toggle, async () => { await api('/room/arm', { method: 'POST', body: { armed: !s.armed } }); setTimeout(render, 3000); }));
    const time = (t) => new Date(t).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    return [h('h1', {}, 'Room'), h('p', { class: 'lede' }, 'Lights from the ambient light sensor. Alerts are pushed only while armed.'),
      h('div', { class: 'stats' },
        h('div', { class: 'stat' }, h('b', {}, h('span', { class: 'dot' + (s.lights === 'on' ? ' on' : '') }), s.lights || '—'), h('span', {}, 'Lights')),
        h('div', { class: 'stat' }, h('b', {}, s.lux == null ? '—' : Math.round(s.lux)), h('span', {}, 'Lux now')),
        h('div', { class: 'stat' }, h('b', {}, s.armed ? 'Armed' : 'Off'), h('span', {}, 'Alerts'))),
      h('p', {}, toggle),
      h('h2', {}, 'Recent changes'), h('table', {}, h('tbody', {}, d.events.map((e) =>
        h('tr', {}, h('td', {}, time(e.t)), h('td', {}, `${e.kind} ${e.value}`), h('td', { class: 'muted' }, e.armed ? 'armed' : '')))))];
  },
};

// ---------- router ----------
function go(path) { history.pushState(null, '', path); render(); }
async function render() {
  const path = location.pathname.replace(/\/+$/, '') || '/';
  document.querySelectorAll('.nav a').forEach((a) => {
    if (a.getAttribute('href') === path) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  const page = pages[path] || (async () => [h('h1', {}, 'Not found'), h('p', {}, h('a', { href: '/', 'data-link': true }, 'Back to the hub'))]);
  try {
    const nodes = await page();
    if (nodes) view.replaceChildren(...[nodes].flat());
    const me = path === '/login' ? { loggedIn: false } : { loggedIn: true };
    logoutBtn.hidden = !me.loggedIn;
    document.title = `${path === '/' ? 'Tinker hub' : path.slice(1)[0].toUpperCase() + path.slice(2)} · Tinker hub`;
  } catch (e) {
    if (location.pathname !== '/login') view.replaceChildren(h('p', { class: 'err' }, e.message));
  }
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (a && a.origin === location.origin && !e.metaKey && !e.ctrlKey) { e.preventDefault(); go(a.pathname + a.search); }
});
logoutBtn.addEventListener('click', async () => { await api('/logout', { method: 'POST' }).catch(() => {}); go('/login'); });
window.addEventListener('popstate', render);
render();
