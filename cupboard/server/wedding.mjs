// Wedding planner (Together → Wedding): functions, a checklist, guests with RSVP links, vendors and a budget.
// One wedding per chat; everyone in that chat plans it. Everything is private: RSVPs are marked by the couple
// (there are no public guest pages).
// Functions and vendor payment dates also appear in the shared calendar (with reminders), via together.mjs.
import { randomBytes } from 'node:crypto';
import { one, all, run, botId } from './db.mjs';

export const PHASES = ['12+ months', '9-12 months', '6-9 months', '3-6 months', '1-3 months', 'Last month', 'Wedding week', 'After'];
export const CATEGORIES = ['Venue', 'Catering', 'Decor', 'Photo & video', 'Outfits', 'Jewellery', 'Makeup & mehendi', 'Music & dance',
  'Invitations & gifts', 'Travel & stay', 'Priest & rituals', 'Other'];
const FUNCTIONS = ['Roka / Engagement', 'Haldi', 'Mehendi', 'Sangeet', 'Wedding', 'Reception'];
// A typical Indian wedding checklist; every item can be edited, reassigned or deleted.
const TEMPLATE = {
  '12+ months': ['Agree on the total budget together', 'Fix the date (and muhurat, if wanted)', 'Draft guest lists: both families', 'Shortlist and book venues'],
  '9-12 months': ['Book photographer and videographer', 'Book caterer (after a food tasting)', 'Book decorator', 'Book bridal makeup artist'],
  '6-9 months': ['Shop wedding outfits', 'Book mehendi artist', 'Book DJ / band and sangeet choreographer', 'Plan honeymoon (passports, visas, bookings)',
    'Block rooms for out-of-town guests'],
  '3-6 months': ['Send save-the-dates', 'Design and order invitation cards', 'Buy jewellery', 'Plan sangeet performances', 'Book baraat and guest transport',
    'Book pandit / priest'],
  '1-3 months': ['Send invitations with RSVP links', 'Final outfit fittings', 'Buy return gifts', 'Confirm menu with the caterer', 'Plan room allotment and seating',
    'Share the day-by-day timeline with vendors'],
  'Last month': ['Final headcount to the caterer (from RSVPs)', 'Pay vendor balances', 'Pack for the wedding and honeymoon', 'Confirm every vendor one week before',
    'Wedding-day emergency kit (safety pins, medicines, chargers)'],
  'Wedding week': ['Hand cash envelopes / payments to a trusted person', 'Keep phones of all vendors with one coordinator'],
  After: ['Register the marriage', 'Send thank-you messages', 'Collect all photos and videos from vendors'],
};
const MEALS = ['veg', 'jain', 'non-veg'];

export function install({ emit, memberIds, canSee, readJson, send, err, postMessage, together }) {
  // ---------- validation ----------
  const str = (max, label) => (v) => { const s = String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max); if (label && !s) throw err(400, `${label} is needed.`); return s || null; };
  const int = (lo, hi) => (v) => (v === '' || v == null ? 0 : Math.max(lo, Math.min(hi, Math.round(Number(v) || 0))));
  const time = (v) => { if (v === '' || v == null) return null; const t = Number(v); if (!Number.isFinite(t) || t < Date.UTC(2020, 0, 1) || t > Date.UTC(2040, 0, 1)) throw err(400, 'Pick a valid date.'); return t; };
  const oneOf = (list, d = null) => (v) => (list.includes(v) ? v : d);
  const url = (v) => { const s = String(v ?? '').trim().slice(0, 400); if (!s) return null; if (!/^https:\/\//i.test(s)) throw err(400, 'Map link must start with https://'); return s; };
  const KINDS = {
    functions: { table: 'w_functions', fields: { name: str(60, 'A name'), starts: time, venue: str(120), map: url, note: str(300), sort: int(0, 999) } },
    tasks: { table: 'w_tasks', fields: { text: str(200, 'The task'), phase: oneOf(PHASES, 'Last month'), owner: str(20), sort: int(0, 9999) } },
    guests: { table: 'w_guests', fields: { name: str(80, 'A name'), side: oneOf(['groom', 'bride', 'both'], 'both'), grp: str(60), phone: str(20),
      adults: int(0, 30), kids: int(0, 30), meal: oneOf(MEALS), note: str(300) } },
    vendors: { table: 'w_vendors', fields: { name: str(80, 'A name'), category: oneOf(CATEGORIES, 'Other'), phone: str(20),
      status: oneOf(['considering', 'booked', 'done'], 'considering'), quote: int(0, 1e9), paid: int(0, 1e9), due: time, note: str(400) } },
  };

  // ---------- reading ----------
  const myWedding = (me) => one('SELECT w.* FROM weddings w JOIN members m ON m.conv_id = w.conv_id AND m.user_id = ? ORDER BY w.id LIMIT 1', me.id);
  const getWedding = (me, id) => { const w = one('SELECT * FROM weddings WHERE id = ?', id); if (!w || !canSee(me, w.conv_id)) throw err(404, 'Not found.'); return w; };
  const J = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
  function full(w) {
    if (!w) return { wedding: null };
    return {
      wedding: { id: w.id, conv: w.conv_id, ...J(w.data, {}), updated: w.updated },
      functions: all('SELECT * FROM w_functions WHERE wedding_id = ? ORDER BY coalesce(starts, 9e15), sort, id', w.id),
      tasks: all('SELECT * FROM w_tasks WHERE wedding_id = ? ORDER BY sort, id', w.id).map((t) => ({ ...t, done: !!t.done })),
      guests: all('SELECT * FROM w_guests WHERE wedding_id = ? ORDER BY lower(name)', w.id).map((g) => ({ ...g, invited: J(g.invited, []), rsvp: J(g.rsvp, {}) })),
      vendors: all('SELECT * FROM w_vendors WHERE wedding_id = ? ORDER BY category, lower(name)', w.id),
      phases: PHASES, categories: CATEGORIES,
    };
  }
  const changed = (w) => {
    run('UPDATE weddings SET updated = ? WHERE id = ?', Date.now(), w.id);
    for (const uid of memberIds(w.conv_id)) emit(uid, 'wedding', { id: w.id });
  };

  // ---------- calendar sync: dated functions and vendor payments show up in the shared calendar ----------
  function syncFunction(w, f, by) {
    if (f.starts) run('UPDATE w_functions SET event_id = ? WHERE id = ?', together.setEvent(f.event_id, { conv: w.conv_id, title: `💍 ${f.name}${f.venue ? ` · ${f.venue}` : ''}`, starts: f.starts, remind: 1440, by }), f.id);
    else if (f.event_id) { together.removeEvent(f.event_id); run('UPDATE w_functions SET event_id = NULL WHERE id = ?', f.id); }
  }
  function syncVendor(w, v, by) {
    const balance = (v.quote || 0) - (v.paid || 0);
    if (v.due && balance > 0) {
      const id = together.setEvent(v.event_id, { conv: w.conv_id, title: `💰 Pay ${v.name}: ₹${balance.toLocaleString('en-IN')} balance`, starts: v.due, allDay: true, remind: 1440, by });
      run('UPDATE w_vendors SET event_id = ? WHERE id = ?', id, v.id);
    } else if (v.event_id) { together.removeEvent(v.event_id); run('UPDATE w_vendors SET event_id = NULL WHERE id = ?', v.id); }
  }
  const sync = (kind, w, row, by) => (kind === 'functions' ? syncFunction(w, row, by) : kind === 'vendors' ? syncVendor(w, row, by) : null);

  // A guest's invited functions must belong to this wedding.
  const cleanInvited = (w, list) => {
    const ok = new Set(all('SELECT id FROM w_functions WHERE wedding_id = ?', w.id).map((r) => r.id));
    return JSON.stringify([...new Set((Array.isArray(list) ? list : []).map(Number))].filter((id) => ok.has(id)));
  };
  const cleanRsvp = (w, r) => {
    const ok = new Set(all('SELECT id FROM w_functions WHERE wedding_id = ?', w.id).map((x) => x.id)), out = {};
    for (const [fid, v] of Object.entries(r && typeof r === 'object' ? r : {})) {
      if (!ok.has(Number(fid)) || !v || typeof v !== 'object') continue;
      out[Number(fid)] = { going: !!v.going, adults: int(0, 30)(v.adults), kids: int(0, 30)(v.kids) };
    }
    return JSON.stringify(out);
  };

  function weddingData(b, old = {}) {
    const d = { ...old };
    if (b.partner1 !== undefined) d.partner1 = str(40, 'Your name')(b.partner1);
    if (b.partner2 !== undefined) d.partner2 = str(40, 'Your partner\'s name')(b.partner2);
    if (b.date !== undefined) d.date = time(b.date);
    if (b.city !== undefined) d.city = str(60)(b.city);
    if (b.budget !== undefined) d.budget = int(0, 1e10)(b.budget);
    if (b.plan !== undefined) d.plan = Object.fromEntries(CATEGORIES.map((c) => [c, int(0, 1e10)(b.plan?.[c])]).filter(([, v]) => v));   // planned per category
    if (b.welcome !== undefined) d.welcome = str(400)(b.welcome);    // a line shown to guests on the RSVP page
    return d;
  }

  // ---------- signed-in routes ----------
  async function route(req, res, path, query, me) {
    const M = req.method;
    let m;
    if (path === '/api/wedding' && M === 'GET') return send(res, 200, full(myWedding(me))), true;
    if (path === '/api/wedding' && M === 'POST') {
      const b = await readJson(req, 8000);
      const conv = Number(b.conv);
      if (!canSee(me, conv) || one('SELECT kind FROM convs WHERE id = ?', conv)?.kind === 'bot') throw err(400, 'Plan it in your chat with your partner.');
      if (one('SELECT 1 FROM weddings WHERE conv_id = ?', conv)) throw err(409, 'That chat already has a wedding plan.');
      const now = Date.now();
      const id = Number(run('INSERT INTO weddings(conv_id, data, created, updated) VALUES(?,?,?,?)', conv, JSON.stringify(weddingData(b)), now, now).lastInsertRowid);
      const w = one('SELECT * FROM weddings WHERE id = ?', id);
      const names = (Array.isArray(b.functions) ? b.functions : FUNCTIONS).map((n) => str(60)(n)).filter(Boolean).slice(0, 15);
      names.forEach((n, i) => run('INSERT INTO w_functions(wedding_id, name, sort, created) VALUES(?,?,?,?)', id, n, i, now));
      if (b.checklist !== false) {
        let i = 0;
        for (const [phase, items] of Object.entries(TEMPLATE)) for (const t of items) run("INSERT INTO w_tasks(wedding_id, text, phase, owner, sort, created) VALUES(?,?,?,'both',?,?)", id, t, phase, i++, now);
      }
      await postMessage(conv, botId(), { kind: 'card', text: 'Your wedding plan is ready: checklist, guest list with RSVPs, vendors and budget. Open Together → Wedding.',
        extra: { title: '💍 Wedding planner', link: { label: 'Open', path: '/together/wedding' } } });
      changed(w);
      return send(res, 200, full(w)), true;
    }
    if ((m = /^\/api\/wedding\/(\d+)$/.exec(path)) && M === 'POST') {
      const w = getWedding(me, Number(m[1]));
      run('UPDATE weddings SET data = ? WHERE id = ?', JSON.stringify(weddingData(await readJson(req, 8000), J(w.data, {}))), w.id);
      changed(w);
      return send(res, 200, full(one('SELECT * FROM weddings WHERE id = ?', w.id))), true;
    }
    if ((m = /^\/api\/wedding\/(\d+)$/.exec(path)) && M === 'DELETE') {          // start over: everything goes, calendar entries too
      const w = getWedding(me, Number(m[1]));
      for (const r of all('SELECT event_id FROM w_functions WHERE wedding_id = ? UNION ALL SELECT event_id FROM w_vendors WHERE wedding_id = ?', w.id, w.id)) together.removeEvent(r.event_id);
      for (const t of ['w_functions', 'w_tasks', 'w_guests', 'w_vendors']) run(`DELETE FROM ${t} WHERE wedding_id = ?`, w.id);
      run('DELETE FROM weddings WHERE id = ?', w.id);
      changed(w);
      return send(res, 200, { ok: true }), true;
    }
    // Paste many guests at once: one per line, "Name, adults, kids" (numbers optional).
    if ((m = /^\/api\/wedding\/(\d+)\/guests\/bulk$/.exec(path)) && M === 'POST') {
      const w = getWedding(me, Number(m[1]));
      const b = await readJson(req, 60_000);
      const lines = String(b.text || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 500);
      if (!lines.length) throw err(400, 'Paste at least one name.');
      const side = KINDS.guests.fields.side(b.side), invited = cleanInvited(w, b.invited), now = Date.now();
      for (const l of lines) {
        const [name, a, k] = l.split(/\s*[,;\t]\s*/);
        if (!name) continue;
        run('INSERT INTO w_guests(wedding_id, name, side, grp, adults, kids, invited, token, created) VALUES(?,?,?,?,?,?,?,?,?)', w.id, str(80)(name) || 'Guest', side,
          str(60)(b.grp), a ? int(0, 30)(a) : 1, k ? int(0, 30)(k) : 0, invited, randomBytes(16).toString('hex'), now);
      }
      changed(w);
      return send(res, 200, full(w)), true;
    }
    if ((m = /^\/api\/wedding\/(\d+)\/(functions|tasks|guests|vendors)$/.exec(path)) && M === 'POST') {
      const w = getWedding(me, Number(m[1])), K = KINDS[m[2]], b = await readJson(req, 8000);
      if (one(`SELECT count(*) AS n FROM ${K.table} WHERE wedding_id = ?`, w.id).n >= 2000) throw err(400, 'That is the most this planner holds.');
      const cols = Object.keys(K.fields).filter((f) => b[f] !== undefined || f === Object.keys(K.fields)[0]);
      const vals = cols.map((f) => K.fields[f](b[f]));
      const extra = m[2] === 'guests' ? { invited: cleanInvited(w, b.invited), rsvp: cleanRsvp(w, b.rsvp), token: randomBytes(16).toString('hex') }
        : m[2] === 'tasks' ? { owner: str(20)(b.owner) || 'both' } : {};
      const allCols = [...cols.filter((c) => !(c in extra)), ...Object.keys(extra)], allVals = [...vals.filter((_, i) => !(cols[i] in extra)), ...Object.values(extra)];
      const id = run(`INSERT INTO ${K.table}(wedding_id, ${allCols.join(', ')}, created) VALUES(?, ${allCols.map(() => '?').join(', ')}, ?)`, w.id, ...allVals, Date.now()).lastInsertRowid;
      sync(m[2], w, one(`SELECT * FROM ${K.table} WHERE id = ?`, id), me.id);
      changed(w);
      return send(res, 200, { id: Number(id), ...full(w) }), true;
    }
    if ((m = /^\/api\/w\/(functions|tasks|guests|vendors)\/(\d+)$/.exec(path)) && (M === 'POST' || M === 'DELETE')) {
      const K = KINDS[m[1]], row = one(`SELECT * FROM ${K.table} WHERE id = ?`, Number(m[2]));
      if (!row) throw err(404, 'Not found.');
      const w = getWedding(me, row.wedding_id);
      if (M === 'DELETE') {
        if (row.event_id) together.removeEvent(row.event_id);
        run(`DELETE FROM ${K.table} WHERE id = ?`, row.id);
        if (m[1] === 'functions') for (const g of all('SELECT id, invited, rsvp FROM w_guests WHERE wedding_id = ?', w.id)) {   // drop it from invitations
          const r = J(g.rsvp, {}); delete r[row.id];
          run('UPDATE w_guests SET invited = ?, rsvp = ? WHERE id = ?', JSON.stringify(J(g.invited, []).filter((x) => x !== row.id)), JSON.stringify(r), g.id);
        }
      } else {
        const b = await readJson(req, 8000), set = {};
        for (const f of Object.keys(K.fields)) if (b[f] !== undefined) set[f] = K.fields[f](b[f]);
        if (m[1] === 'tasks' && b.done !== undefined) Object.assign(set, { done: b.done ? 1 : 0, done_by: b.done ? me.id : null, done_at: b.done ? Date.now() : null });
        if (m[1] === 'tasks' && b.owner !== undefined) set.owner = str(20)(b.owner) || 'both';
        if (m[1] === 'guests' && b.invited !== undefined) set.invited = cleanInvited(w, b.invited);
        if (m[1] === 'guests' && b.rsvp !== undefined) set.rsvp = cleanRsvp(w, b.rsvp);
        const cols = Object.keys(set);
        if (cols.length) run(`UPDATE ${K.table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, ...cols.map((c) => set[c]), row.id);
        sync(m[1], w, one(`SELECT * FROM ${K.table} WHERE id = ?`, row.id), me.id);
      }
      changed(w);
      return send(res, 200, full(w)), true;
    }
    return false;
  }

  return { route };
}
