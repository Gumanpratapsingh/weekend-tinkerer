// Expense logger. Input: Siri shortcut / ntfy messages on "<topic>-exp" like "250 swiggy dinner",
// plus commands: today, week, month, undo, budget food 5000, budgets. The hub page reads and edits
// the same data through /api/expenses. Data never leaves the phone except as your own ntfy replies.
import { randomUUID } from 'node:crypto';
import { load, save, push, listen, groq, daily, istDate, istMonth, log } from '../core.mjs';

export const CATEGORIES = ['Food', 'Transport', 'Shopping', 'Bills', 'Rent', 'Health', 'Entertainment', 'Gifts', 'Other'];
const KEYWORDS = {
  Food: /swiggy|zomato|food|lunch|dinner|breakfast|snack|coffee|tea|restaurant|biryani|dosa|grocer|milk|veg|fruit|bigbasket|blinkit|zepto|instamart/i,
  Transport: /uber|ola|rapido|auto|cab|taxi|metro|bus|train|petrol|fuel|diesel|parking|toll|flight|irctc/i,
  Shopping: /amazon|flipkart|myntra|ajio|shop|clothes|shoes|gadget|meesho|nykaa/i,
  Bills: /bill|electric|tneb|eb |wifi|airtel|jio|recharge|internet|gas|lpg|water|dth|postpaid|emi/i,
  Rent: /rent|maintenance|pg |hostel|deposit/i,
  Health: /medic|doctor|pharma|hospital|gym|clinic|lab|apollo|pharmeasy|1mg|dental/i,
  Entertainment: /movie|netflix|prime|hotstar|spotify|game|concert|pvr|inox|youtube|party/i,
  Gifts: /gift|present|donation|charity/i,
};

let data = load('expenses.json', { items: [], budgets: {} });
const persist = () => save('expenses.json', data);
const rupees = (n) => '₹' + Math.round(n).toLocaleString('en-IN');

async function categorise(note) {
  for (const [cat, re] of Object.entries(KEYWORDS)) if (re.test(note)) return cat;
  try {
    const out = await groq([{ role: 'user', content:
      `Classify this personal expense note into exactly one of: ${CATEGORIES.join(', ')}.\nNote: "${note}"\nReply with JSON {"category": "..."}` }],
      { json: true, maxTokens: 300, temperature: 0 });
    return CATEGORIES.includes(out.category) ? out.category : 'Other';
  } catch { return 'Other'; }
}

function add({ amount, note, category, date }) {
  const item = { id: randomUUID(), amount: Math.round(Number(amount) * 100) / 100, note: String(note || '').slice(0, 120),
    category, date: date || istDate(), t: Date.now() };
  data.items.push(item);
  persist();
  return item;
}

const inMonth = (m) => data.items.filter((i) => i.date.startsWith(m));
function totals(items) {
  const by = {};
  for (const i of items) by[i.category] = (by[i.category] || 0) + i.amount;
  const total = items.reduce((s, i) => s + i.amount, 0);
  return { total, byCategory: Object.fromEntries(Object.entries(by).sort((a, b) => b[1] - a[1])) };
}
const summaryText = (items) => {
  const { total, byCategory } = totals(items);
  return `${rupees(total)} total\n` + Object.entries(byCategory).map(([c, v]) => `${c} ${rupees(v)}`).join(' · ');
};

// Warn once per category per month when spending crosses 80% and 100% of its budget.
function budgetCheck(category) {
  const budget = data.budgets[category];
  if (!budget) return;
  const m = istMonth();
  const spent = inMonth(m).filter((i) => i.category === category).reduce((s, i) => s + i.amount, 0);
  data.warned ||= {};
  for (const level of [1, 0.8]) {
    const key = `${m}:${category}:${level}`;
    if (spent >= budget * level && !data.warned[key]) {
      data.warned[key] = true; persist();
      push(level === 1 ? `${category} budget used up` : `${category} budget 80% used`,
        `${rupees(spent)} of ${rupees(budget)} this month.`, { tags: 'moneybag', priority: level === 1 ? 'high' : 'default' });
      break;
    }
  }
}

async function onMessage(text) {
  const t = text.toLowerCase().replace(/[₹,]/g, '').trim();
  if (t === 'undo') {
    const last = data.items.pop(); persist();
    return push('Expense removed', last ? `${rupees(last.amount)} ${last.note} (${last.category})` : 'Nothing to undo.', { tags: 'wastebasket' });
  }
  if (t === 'today') return push('Spent today', summaryText(data.items.filter((i) => i.date === istDate())) || 'Nothing yet.', { tags: 'moneybag' });
  if (t === 'week') {
    const since = istDate(Date.now() - 6 * 86400e3);
    return push('Spent this week', summaryText(data.items.filter((i) => i.date >= since)), { tags: 'moneybag' });
  }
  if (t === 'month' || /how much/.test(t)) return push(`Spent in ${istMonth()}`, summaryText(inMonth(istMonth())), { tags: 'moneybag' });
  if (t === 'budgets') {
    const lines = Object.entries(data.budgets).map(([c, b]) => `${c} ${rupees(b)}`);
    return push('Monthly budgets', lines.join(' · ') || 'None set. Send e.g. "budget food 5000".', { tags: 'moneybag' });
  }
  const b = /^budget\s+(\w+)\s+(\d+)/.exec(t);
  if (b) {
    const cat = CATEGORIES.find((c) => c.toLowerCase() === b[1]);
    if (!cat) return push('Unknown category', `Use one of: ${CATEGORIES.join(', ')}`);
    data.budgets[cat] = Number(b[2]); persist();
    return push('Budget set', `${cat}: ${rupees(b[2])} a month.`, { tags: 'moneybag' });
  }
  const m = /(\d+(?:\.\d+)?)/.exec(t);
  if (!m) return push('Could not read that', 'Send an amount and what it was for, e.g. "250 swiggy dinner".');
  const note = text.replace(/spent|rs\.?|inr|rupees|₹|on/gi, ' ').replace(m[1], ' ').replace(/\s+/g, ' ').trim() || 'expense';
  const item = add({ amount: m[1], note, category: await categorise(note) });
  log(`expense ${item.amount} ${item.category}`);
  await push(`Logged Rs ${Math.round(item.amount)} - ${item.category}`, `${item.note}. This month: ${rupees(totals(inMonth(istMonth())).total)}. Send "undo" to remove.`, { tags: 'white_check_mark' });
  budgetCheck(item.category);
}

async function monthlySummary() {
  const last = istMonth(Date.now() - 86400e3 * 2);          // runs on the 1st: summarise the previous month
  const items = inMonth(last);
  if (!items.length) return;
  const prev = istMonth(Date.parse(last + '-01') - 86400e3);
  const prevTotal = totals(inMonth(prev)).total;
  const top = [...items].sort((a, b) => b.amount - a.amount).slice(0, 3).map((i) => `${rupees(i.amount)} ${i.note}`).join(', ');
  const change = prevTotal ? ` (${totals(items).total >= prevTotal ? '+' : ''}${Math.round((totals(items).total / prevTotal - 1) * 100)}% vs ${prev})` : '';
  await push(`Your ${last} spending`, `${summaryText(items)}${change}\nBiggest: ${top}`, { tags: 'bar_chart' });
}

export default {
  start() {
    listen('exp', onMessage);
    daily(9, 0, () => { if (istDate().endsWith('-01')) return monthlySummary(); });
  },
  routes: {
    'GET /api/expenses': ({ query }) => {
      const m = /^\d{4}-\d{2}$/.test(query.month || '') ? query.month : istMonth();
      const items = inMonth(m).sort((a, b) => b.date.localeCompare(a.date) || b.t - a.t);
      return { month: m, items, ...totals(items), budgets: data.budgets, categories: CATEGORIES };
    },
    'POST /api/expenses': async ({ body }) => {
      const amount = Number(body.amount);
      if (!(amount > 0 && amount < 10_000_000)) throw Object.assign(new Error('Enter a valid amount.'), { status: 400, expose: true });
      const category = CATEGORIES.includes(body.category) ? body.category : await categorise(body.note || '');
      const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date || '') ? body.date : undefined;
      const item = add({ amount, note: body.note, category, date });
      budgetCheck(category);
      return item;
    },
    'DELETE /api/expenses/:id': ({ id }) => {
      data.items = data.items.filter((i) => i.id !== id); persist();
      return { ok: true };
    },
    'POST /api/expenses/budget': ({ body }) => {
      if (!CATEGORIES.includes(body.category)) throw Object.assign(new Error('Unknown category.'), { status: 400, expose: true });
      const v = Number(body.amount);
      if (v > 0) data.budgets[body.category] = v; else delete data.budgets[body.category];
      persist();
      return { budgets: data.budgets };
    },
    'GET /api/expenses/csv': ({ query }) => {
      const m = /^\d{4}-\d{2}$/.test(query.month || '') ? query.month : istMonth();
      const rows = inMonth(m).map((i) => [i.date, i.category, i.amount, `"${i.note.replace(/"/g, '""')}"`].join(','));
      return { filename: `expenses-${m}.csv`, csv: ['date,category,amount,note', ...rows].join('\n') };
    },
  },
};
