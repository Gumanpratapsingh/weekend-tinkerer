// Bank SMS -> expense. An iPhone automation ("When I get a message containing 'debited'") runs a
// shortcut that POSTs the SMS text here with a secret token. Only the amount and merchant are kept;
// the SMS itself is never stored or logged (it can hold account digits and reference numbers).
import { readFileSync, existsSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { HOME, send, readBody, visitorIp, log, push, load, save, loginLocked, noteFailure } from '../core.mjs';
import { logExpense } from './expenses.mjs';

const TOKEN_FILE = join(HOME, 'tinker', 'sms-token');   // 64 hex chars, created on the phone, never in git

// Messages that mention money but are not a spend we made.
const IGNORE = /\b(credited to your|has been credited|received|refund|reversed|reversal|cashback|otp|one.?time password|will be debited|to be debited|due on|payment due|min(imum)? amount due|declined|failed|unsuccessful|request(ed)? (of|for)|collect request|e-?mandate|autopay (set|registered))\b/i;
const DEBIT = /\b(debited|spent|sent|paid|withdrawn|purchase|txn of|transaction of|payment of)\b/i;

const AMOUNT = [
  /(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d{1,2})?)/i,           // Rs.450.00, INR 1,299.00, ₹250
  /debited\s+(?:by|for|with)\s+(?:rs\.?|inr|₹)?\s*([\d,]+(?:\.\d{1,2})?)/i,   // SBI: "debited by 250.0"
];
const MERCHANT = [
  /UPI\/P2[MA]\/\d+\/([^/\s]+)/i,                                   // Axis: UPI/P2M/123/ZOMATO
  /;\s*([A-Za-z0-9 .&'-]{2,40}?)\s+credited/i,                      // ICICI: "; AMAZON PAY credited"
  /\b(?:at|to|towards|trf to|info:?)\s+(?:vpa\s+)?([A-Za-z0-9@._&' -]{2,40}?)(?=\s+(?:on|ref\w*|upi|via|using|not|avl|from|dated|thru)\b|[.;(,]|\s*$)/i,
];

const clean = (m) => {
  let s = m.trim();
  if (s.includes('@')) s = s.split('@')[0];                         // VPA: swiggy@icici -> swiggy
  s = s.replace(/[._-]?(s|q|m)?\d{4,}$/i, '')                        // paytm.s12345 / zomato123456 -> paytm / zomato
    .replace(/\b(pvt|private|ltd|limited|india|online|payments?|technologies|services)\b\.?/gi, '')
    .replace(/[._]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  return s.length >= 2 && !/^[x*\d ]+$/i.test(s) ? s : '';
};

export function parseBankSms(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return { skip: 'empty' };
  if (IGNORE.test(t)) return { skip: 'not a spend' };
  if (!DEBIT.test(t)) return { skip: 'no debit' };
  let amount = null;
  for (const re of AMOUNT) { const m = re.exec(t); if (m) { amount = Number(m[1].replace(/,/g, '')); break; } }
  if (!(amount > 0 && amount < 10_000_000)) return { skip: 'no amount' };
  let merchant = '';
  for (const re of MERCHANT) { const m = re.exec(t); if (m && (merchant = clean(m[1]))) break; }
  return { amount, merchant: merchant || 'bank debit' };
}

// Drop repeats: the same SMS twice (automation retries) or the same spend reported twice (UPI app + bank).
let recent = load('sms-recent.json', []);   // [{ h, amount, merchant, t }], hashes only
function duplicate(text, p) {
  const h = createHash('sha256').update(text).digest('hex').slice(0, 24);
  const now = Date.now();
  recent = recent.filter((r) => now - r.t < 24 * 3600e3);
  const dup = recent.some((r) => r.h === h || (r.amount === p.amount && r.merchant === p.merchant && now - r.t < 3 * 60e3));
  if (!dup) { recent.push({ h, amount: p.amount, merchant: p.merchant, t: now }); save('sms-recent.json', recent); }
  return dup;
}

function tokenOk(got) {
  if (!existsSync(TOKEN_FILE) || !got) return false;
  const want = Buffer.from(readFileSync(TOKEN_FILE, 'utf8').trim());
  const g = Buffer.from(String(got));
  return g.length === want.length && timingSafeEqual(g, want);
}

// POST /api/expenses/sms  { text }  with header X-Sms-Token. Returns what it did (never echoes the SMS).
export async function smsIngest(req, res) {
  const ip = visitorIp(req);
  if (loginLocked(ip)) return send(res, 429, { error: 'Too many attempts.' });
  if (!tokenOk(req.headers['x-sms-token'])) {
    noteFailure(ip); log(`sms: bad token from ${ip}`);
    return send(res, 401, { error: 'Unauthorized' });
  }
  let body;
  try { body = await readBody(req, 4000); } catch { return send(res, 400, { error: 'Bad request' }); }
  const text = String(body.text || '');
  const p = parseBankSms(text);
  if (p.skip) { log(`sms: skipped (${p.skip})`); return send(res, 200, { ok: true, skipped: p.skip }); }
  if (duplicate(text, p)) { log('sms: duplicate ignored'); return send(res, 200, { ok: true, skipped: 'duplicate' }); }
  const item = await logExpense({ amount: p.amount, note: p.merchant, source: 'sms' });
  return send(res, 200, { ok: true, amount: item.amount, category: item.category, note: item.note });
}
