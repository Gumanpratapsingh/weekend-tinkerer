// Payback plan page: reads and saves the owner's plan through /api/payback (owner login only).
// No names or amounts live in this file: they all come from the server.
(function () {
  const API = '../api/payback';
  const app = document.getElementById('app');
  const inr = (n) => '₹' + Math.round(n).toLocaleString('en-IN');
  const monthName = (m) => new Date(m + '-01T00:00:00').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const got = (p) => (typeof p.paid === 'number' ? p.paid : 0);
  const OWN = 'My own money';   // money given that pays back no debt (a gift or help), kept apart from the owed totals
  const ym = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  let state = null, saveTimer = null, statusText = '', statusErr = false, locked = false;

  function gate(title, text, link) {
    app.innerHTML = `<div class="gate"><h1>${esc(title)}</h1><p class="meta">${esc(text)}</p>${link ? `<a href="../">Open the hub to log in</a>` : ''}</div>`;
  }

  // What a payment sent to `to` can count toward: their own debt, someone else's debt (sent through them), or my own money.
  function forOptions(to) {
    if (to === 'Savings') return '<option value="Savings">Savings</option>';
    const names = Object.keys(state.owed);
    return [`<option value="${esc(to)}">${esc(to)}'s money</option>`,
      ...names.filter((w) => w !== to).map((w) => `<option value="${esc(w)}">${esc(w)}'s money (sent through ${esc(to)})</option>`),
      `<option value="${OWN}">My own money (not owed)</option>`].join('');
  }

  function render() {
    const P = state.payments, OWED = state.owed, WEDDING = state.wedding;
    const paid = (who) => P.filter((p) => p.who === who).reduce((n, p) => n + got(p), 0);
    const owedLeft = Object.keys(OWED).reduce((n, w) => n + Math.max(0, OWED[w] - paid(w)), 0);
    const saved = paid('Savings');
    // A planned row shrinks when that person's debt was already (partly) paid early or through someone else.
    const need = new Map();
    for (const w of Object.keys(OWED)) {
      let left = Math.max(0, OWED[w] - paid(w));
      for (const p of P.filter((x) => x.who === w && !x.extra && got(x) === 0)) { const n = Math.min(p.amount, left); need.set(p.id, n); left -= n; }
    }
    const needOf = (p) => (need.has(p.id) ? need.get(p.id) : p.amount);
    const covered = (p) => !p.extra && got(p) === 0 && needOf(p) === 0;
    const settled = (p) => got(p) >= p.amount || covered(p);
    const payee = (p) => (p.to && p.to !== p.who ? p.to : p.who);
    const label = (p) => p.who === 'Savings' ? 'Savings' : p.who === OWN ? 'Gave ' + esc(payee(p))
      : 'Pay ' + esc(payee(p)) + (p.to && p.to !== p.who ? ` <span class="for">for ${esc(p.who)}</span>` : '');
    const next = P.find((p) => !p.extra && got(p) === 0 && needOf(p) > 0);
    const bar = (pct, label) => `<div class="bar" role="img" aria-label="${esc(label)}"><i data-w="${Math.min(100, pct)}"></i></div>`;
    const people = Object.keys(OWED).map((w) => {
      const done = paid(w), pct = Math.round((done / OWED[w]) * 100);
      const last = P.filter((p) => p.who === w && !p.extra && needOf(p) > 0 && got(p) === 0).slice(-1)[0];
      const via = {};
      for (const p of P) if (p.who === w && got(p) > 0 && p.to && p.to !== w) via[p.to] = (via[p.to] || 0) + got(p);
      const viaText = Object.entries(via).map(([t, n]) => ` · ${inr(n)} sent through ${esc(t)}`).join('');
      return `<div class="person"><div class="prow"><h3>${esc(w)}</h3><span class="pill">${done >= OWED[w] ? 'Paid off ✓' : pct + '%'}</span></div>
        ${bar(pct, `${w}: ${pct}% paid`)}
        <div class="meta num">${inr(done)} of ${inr(OWED[w])} paid · ${done >= OWED[w] ? 'all done' : inr(OWED[w] - done) + ' left' + (last ? ', done by ' + monthName(last.month) : '')}${viaText}</div></div>`;
    }).join('');
    const wpct = WEDDING ? Math.round((saved / WEDDING) * 100) : 0;
    const wedding = WEDDING ? `<div class="person wedding"><div class="prow"><h3>Wedding money</h3><span class="pill">${saved >= WEDDING ? 'Ready ✓' : wpct + '%'}</span></div>
      ${bar(wpct, `Wedding savings ${wpct}%`)}
      <div class="meta num">${inr(saved)} of ${inr(WEDDING)} saved</div></div>` : '';
    const ownBy = {};
    for (const p of P) if (p.who === OWN && got(p) > 0) ownBy[payee(p)] = (ownBy[payee(p)] || 0) + got(p);
    const ownTotal = Object.values(ownBy).reduce((n, x) => n + x, 0);
    const own = ownTotal ? `<div class="person own"><div class="prow"><h3>Given from my own money</h3><span class="pill">not owed</span></div>
      <div class="meta num">${inr(ownTotal)} in all · ${Object.entries(ownBy).map(([t, n]) => `${esc(t)} ${inr(n)}`).join(' · ')}</div></div>` : '';
    const monthsList = [...new Set(P.map((p) => p.month))];
    const months = monthsList.map((m) => {
      const rows = P.filter((p) => p.month === m);
      const total = rows.filter((p) => !p.extra).reduce((n, p) => n + (got(p) > 0 ? p.amount : needOf(p)), 0);
      const moved = rows.filter((p) => p.who !== OWN).reduce((n, p) => n + got(p), 0);   // a gift is not plan progress
      return `<section class="month${rows.every(settled) ? ' complete' : ''}"><div class="mhead"><h2>${monthName(m)}</h2>
        <span class="meta num">${inr(moved)} of ${inr(total)} done</span></div><ul>${rows.map((p) => `
        <li class="${settled(p) ? 'done' : ''}"><div class="item">
          <label for="c-${p.id}"><input type="checkbox" id="c-${p.id}" data-id="${p.id}" ${got(p) > 0 || covered(p) ? 'checked' : ''} ${locked || covered(p) ? 'disabled' : ''}>
          <span class="what"><b class="${p.who === 'Savings' ? 'tag-save' : p.who === OWN ? 'tag-own' : ''}">${p.extra ? 'Extra: ' : ''}${label(p)}</b>
          <small>${covered(p) ? 'Already paid earlier' : esc(p.note)}${p.who === OWN ? ' · my own money, not owed' : ''}${p.doneAt && got(p) > 0 ? ' · ' + esc(p.doneAt) : ''}</small></span></label>
          <span class="paidbox"><input type="text" inputmode="numeric" id="a-${p.id}" data-amt="${p.id}" aria-label="Amount paid to ${esc(payee(p))}"
            value="${got(p) > 0 ? got(p).toLocaleString('en-IN') : ''}" placeholder="${needOf(p).toLocaleString('en-IN')}" ${locked || covered(p) ? 'disabled' : ''}>
          ${got(p) > 0 && got(p) < p.amount && !p.extra ? `<small class="short num">${inr(p.amount - got(p))} short</small>`
            : p.extra ? `<button type="button" class="rm" data-rm="${p.id}" ${locked ? 'disabled' : ''}>Remove</button>`
            : covered(p) ? `<small class="num">covered</small>`
            : needOf(p) < p.amount ? `<small class="num">now ${inr(needOf(p))} · plan ${inr(p.amount)}</small>`
            : `<small class="num">plan ${inr(p.amount)}</small>`}</span></div></li>`).join('')}</ul></section>`;
    }).join('');
    const toList = [...Object.keys(OWED), 'Savings'];
    const nowM = ym(new Date());
    const addMonths = [...new Set([nowM, ...monthsList])].sort();
    app.innerHTML = `<header><div><h1>Payback Plan 2027</h1>
        <p class="sub">Tick a payment when it's paid in full, or type what you actually paid.</p></div>
      <div class="headline"><div><div class="label">Still owed</div><div class="big num">${inr(owedLeft)}</div></div>
        <div><div class="label">Saved for wedding</div><div class="big num">${inr(saved)}</div></div></div>
      ${next ? `<div class="next"><span class="label">Next</span><span><strong>${next.who === 'Savings' ? 'Save' : label(next)} ${inr(needOf(next))}</strong> · ${monthName(next.month)}</span></div>`
             : P.length ? `<div class="next"><strong>Everyone is paid and the wedding money is saved. 🎉</strong></div>` : ''}
      <div class="status${statusErr ? ' err' : ''}" id="status">${esc(statusText)}</div></header>
      <div class="people">${people}${wedding}${own}</div>
      <div class="months">${months}</div>
      <section class="add"><h2>Record a payment</h2>
        <span class="meta">Money you sent that isn't ticked above: paying early, catching up, sending one person's money through someone else, or your own money (not owed). Paying early lowers the later planned payments for that person.</span>
        <form id="addform"><div class="f"><span class="label">Sent to</span><select id="add-to">
          ${toList.map((w) => `<option>${esc(w)}</option>`).join('')}</select></div>
          <div class="f"><span class="label">Counts toward</span><select id="add-for">${forOptions(toList[0])}</select></div>
          <div class="f"><span class="label">Amount (₹)</span><input id="add-amt" type="text" inputmode="numeric" placeholder="5,000" required></div>
          <div class="f"><span class="label">Month</span><select id="add-month">
          ${addMonths.map((m) => `<option value="${m}">${monthName(m)}</option>`).join('')}</select></div>
          <button type="submit" ${locked ? 'disabled' : ''}>Add</button></form></section>
      <footer><span>Saved on your Dell. Only your own hub login can open this plan.</span></footer>`;
    for (const i of app.querySelectorAll('.bar > i')) i.style.width = i.dataset.w + '%';   // set from script: the hub's CSP blocks inline styles
  }

  function setStatus(t, err) { statusText = t; statusErr = !!err; const el = document.getElementById('status'); if (el) { el.textContent = t; el.className = 'status' + (err ? ' err' : ''); } }

  async function save() {
    setStatus('Saving…');
    try {
      const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub': '1' }, body: JSON.stringify(state) });
      const out = await r.json().catch(() => ({}));
      if (r.ok) { state.updated = out.updated; setStatus('Saved'); return; }
      if (r.status === 409) { locked = true; render(); setStatus(out.error || 'Changed somewhere else. Reload the page.', true); return; }
      if (r.status === 401) { setStatus('You were logged out. Log in on the hub, then reload. This change was not saved.', true); return; }
      setStatus(out.error || 'Could not save. Check the connection and try again.', true);
    } catch { setStatus('Could not reach the Dell. This change is not saved yet; it will try again on your next change.', true); }
  }

  const toNum = (v) => Math.round(Number(String(v).replace(/[^0-9.]/g, '')) || 0);
  const today = () => new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  function changed(focusId) {
    render();
    if (focusId) document.getElementById(focusId)?.focus();
    setStatus('Saving soon…');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 1200);   // several quick changes go out as one save
  }
  app.addEventListener('change', (e) => {
    if (!state) return;
    if (e.target.id === 'add-to') { document.getElementById('add-for').innerHTML = forOptions(e.target.value); return; }
    if (locked) return;
    const box = e.target.closest('input[type=checkbox]');
    if (box) {
      const p = state.payments.find((x) => x.id === box.dataset.id);
      if (box.checked) { p.paid = p.amount; p.doneAt = today(); } else { delete p.paid; delete p.doneAt; }
      return changed('c-' + p.id);
    }
    const amt = e.target.closest('input[data-amt]');
    if (amt) {
      const p = state.payments.find((x) => x.id === amt.dataset.amt);
      const n = toNum(amt.value);
      if (n > 0) { p.paid = n; p.doneAt = today(); } else { delete p.paid; delete p.doneAt; }
      return changed();
    }
  });
  app.addEventListener('click', (e) => {
    const rm = e.target.closest('button[data-rm]');
    if (!rm || locked) return;
    state.payments = state.payments.filter((p) => p.id !== rm.dataset.rm);
    changed();
  });
  app.addEventListener('submit', (e) => {
    e.preventDefault();
    if (locked || !state) return;
    const n = toNum(document.getElementById('add-amt').value);
    if (!n) { setStatus('Type an amount to add.', true); return; }
    const to = document.getElementById('add-to').value, who = document.getElementById('add-for').value, month = document.getElementById('add-month').value;
    const note = who === 'Savings' ? 'Extra saving' : who === OWN ? 'Given' : to !== who ? `${who}'s money, sent through ${to}` : 'Extra payment';
    const row = { id: 'x' + Date.now().toString(36), month, who, amount: n, paid: n, doneAt: today(), note, extra: true };
    if (to !== who) row.to = to;
    const after = state.payments.findIndex((p) => p.month > month);   // keep months in order, new months included
    state.payments.splice(after === -1 ? state.payments.length : after, 0, row);
    changed();
  });

  fetch(API, { cache: 'no-store' }).then(async (r) => {
    if (r.status === 401) return gate('Log in first', 'This plan opens only after you log in to your hub.', true);
    if (!r.ok) return gate('Not available', 'This page is not available here.', false);
    state = await r.json();
    render();
  }).catch(() => gate('Could not reach the Dell', 'Check your internet and reload.', false));
})();
