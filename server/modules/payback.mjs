// Payback plan: the owner's month-by-month plan for paying people back and saving for the wedding.
// Owner login only (index.mjs refuses everyone else). The plan itself lives in data/payback.json on the
// server, never in the public repo or the page: the first GET without that file returns an empty plan.
import { load, save, log } from '../core.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });
const FILE = 'payback.json';

function clean(p) {
  const id = String(p.id || '').slice(0, 40);
  const month = String(p.month || '');
  const who = String(p.who || '').trim().slice(0, 30);
  const amount = Math.round(Number(p.amount));
  if (!/^[a-z0-9-]{1,40}$/i.test(id) || !/^\d{4}-\d{2}$/.test(month) || !who || !(amount > 0 && amount < 1e8)) throw fail(400, 'Bad payment row.');
  const row = { id, month, who, amount, note: String(p.note || '').slice(0, 120) };
  if (p.paid !== undefined && p.paid !== null) {
    const paid = Math.round(Number(p.paid));
    if (!(paid >= 0 && paid < 1e8)) throw fail(400, 'Bad paid amount.');
    if (paid > 0) { row.paid = paid; row.doneAt = String(p.doneAt || '').slice(0, 30); }
  }
  if (p.extra) row.extra = true;
  const to = String(p.to || '').trim().slice(0, 30);   // who actually received it, when it counts toward someone else's debt
  if (to && to !== who) row.to = to;
  return row;
}

export default {
  routes: {
    'GET /api/payback': async () => {
      const d = load(FILE, null);
      return d || { owed: {}, wedding: 0, payments: [], updated: null };
    },

    // The page sends the whole plan back after each change; `updated` guards against an older tab overwriting a newer save.
    'POST /api/payback': async ({ body }) => {
      const cur = load(FILE, null);
      if (cur && body.updated !== cur.updated) throw fail(409, 'This plan was changed somewhere else. Reload to see the latest.');
      if (!Array.isArray(body.payments) || body.payments.length > 500) throw fail(400, 'Bad plan.');
      const owed = {};
      for (const [k, v] of Object.entries(body.owed || {})) {
        const n = Math.round(Number(v));
        if (String(k).length <= 30 && n > 0 && n < 1e8) owed[String(k)] = n;
      }
      const next = { owed, wedding: Math.max(0, Math.round(Number(body.wedding) || 0)), payments: body.payments.map(clean), updated: new Date().toISOString() };
      save(FILE, next);
      log(`payback plan saved (${next.payments.filter((p) => p.paid).length} payments recorded)`);
      return { ok: true, updated: next.updated };
    },
  },
};
