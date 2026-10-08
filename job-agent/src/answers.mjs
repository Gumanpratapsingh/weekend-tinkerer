// The agent's question memory: every question a form or recruiter asks, and the owner's answer.
// Lookup order: exact match -> near match -> LLM match against known answers/resume facts -> ask the owner.
import { llm, master, config, log, privateProfile } from './core.mjs';
import { one, all, run, norm } from './db.mjs';

// Questions almost every Indian application asks. Asked once on WhatsApp during setup.
export const SEED = [
  'What is your notice period (in days)?',
  'Are you an immediate joiner or currently serving notice?',
  'What is your current CTC (in LPA)?',
  'What is your expected CTC (in LPA)?',
  'What is your current location?',
  'Are you willing to relocate? If yes, to which cities?',
  'Are you open to working from office / hybrid?',
  'Total years of professional experience?',
  'Years of experience with Java?',
  'Years of experience with Spring Boot?',
  'Years of experience with AI / LLM applications?',
  'Do you need visa sponsorship to work in the role\'s country?',
  'What is your gender? (for diversity forms; you may say "prefer not to say")',
  'Short answer to "Why do you want to join us?" that I can adapt per company',
];

const words = (s) => new Set(norm(s).split(' ').filter((w) => w.length > 2));
function similarity(a, b) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

export function remember(question, answer, source = 'owner') {
  const n = norm(question);
  const existing = one('SELECT id FROM questions WHERE norm = ?', n);
  if (existing) run('UPDATE questions SET answer = ?, updated_at = ?, source = ? WHERE id = ?', answer, Date.now(), source, existing.id);
  else run('INSERT INTO questions(question, norm, answer, source, created_at, updated_at) VALUES(?,?,?,?,?,?)', question, n, answer, source, Date.now(), Date.now());
  return one('SELECT id FROM questions WHERE norm = ?', n).id;
}

// Register a question with no answer yet (so it can be asked). Returns its row.
export function unanswered(question, { kind = 'text', options = null, source = '' } = {}) {
  const n = norm(question);
  let q = one('SELECT * FROM questions WHERE norm = ?', n);
  if (!q) {
    run('INSERT INTO questions(question, norm, kind, options, source, created_at) VALUES(?,?,?,?,?,?)',
      question, n, kind, options ? JSON.stringify(options) : null, source, Date.now());
    q = one('SELECT * FROM questions WHERE norm = ?', n);
  }
  return q;
}

const used = (id) => run('UPDATE questions SET uses = uses + 1 WHERE id = ?', id);

/**
 * Resolve a batch of fields/questions. Each item: {key, label, type, options?, required?}.
 * Returns {answers: {key: value}, unknown: [item]}. Unknown required items must be asked to the owner.
 */
export async function resolve(items, context = '') {
  const known = all('SELECT id, question, answer FROM questions WHERE answer IS NOT NULL');
  const answers = {};
  const pending = [];
  for (const it of items) {
    const exact = known.find((k) => norm(k.question) === norm(it.label));
    const near = exact || known.map((k) => [k, similarity(k.question, it.label)]).filter(([, s]) => s >= 0.75).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (near && fits(near.answer, it)) { answers[it.key] = coerce(near.answer, it); used(near.id); }
    else pending.push(it);
  }
  if (!pending.length) return { answers, unknown: [] };

  // One LLM call for everything left: match to known answers or derive from resume facts, else "UNKNOWN".
  const m = master();
  const facts = [
    `Name: ${m.name}. Email: ${m.contact.email}. Phone: ${m.contact.phone}. LinkedIn: https://${m.contact.linkedin}. GitHub: https://${m.contact.github}.`,
    `Education: ${m.education.map((e) => `${e.degree}, ${e.school}, ${e.dates}`).join('; ')}.`,
    `Current: ${m.experience[0].title} at ${m.experience[0].org} since ${m.experience[0].dates.split('–')[0].trim()}; at Finzly since Aug 2024.`,
    `Skills: ${Object.values(m.skills).flat().join(', ')}.`,
  ].join('\n');
  let out = {};
  try {
    out = await llm([
      { role: 'system', content: `You fill a job application for the candidate. For each field, answer ONLY from the KNOWN ANSWERS or FACTS.
- If a known answer has the same meaning, adapt it to the field (e.g. pick the matching option, convert to a number).
- Yes/no skill questions ("Do you have experience with X?") may be answered from FACTS: "Yes" only if X is in FACTS.
- Years with a skill in FACTS: use full-time years since Aug 2024 (round down), unless a known answer says otherwise.
- Anything personal (salary, notice, visa, relocation, demographics, references, cover letters, opinions) that is not in KNOWN ANSWERS: "UNKNOWN".
- For choice fields the answer must be exactly one of the options, or "UNKNOWN".
Return JSON {"<key>": "<answer or UNKNOWN>"}.` },
      { role: 'user', content: `FACTS:\n${facts}\n\nKNOWN ANSWERS:\n${known.map((k) => `Q: ${k.question}\nA: ${k.answer}`).join('\n')}\n\n`
        + `CONTEXT: ${context}\n\nFIELDS:\n${JSON.stringify(pending.map(({ key, label, type, options }) => ({ key, label, type, options })))}` },
    ], { json: true, maxTokens: 900, temperature: 0 });
  } catch (e) { log(`resolve llm: ${e.message}`); }

  const unknown = [];
  for (const it of pending) {
    const a = out[it.key];
    if (a && a !== 'UNKNOWN' && fits(a, it)) { answers[it.key] = coerce(a, it); remember(it.label, String(answers[it.key]), 'derived'); }
    else unknown.push(it);
  }
  return { answers, unknown };
}

function fits(answer, it) {
  if (it.options?.length) return it.options.some((o) => norm(o) === norm(answer)) || !!pickOption(answer, it.options);
  if (it.type === 'number') return !Number.isNaN(parseFloat(String(answer).replace(/[^0-9.]/g, '')));
  return true;
}
function pickOption(answer, options) {
  const a = norm(answer);
  return options.find((o) => norm(o) === a) || options.find((o) => norm(o).startsWith(a) || a.startsWith(norm(o)));
}
function coerce(answer, it) {
  if (it.options?.length) return pickOption(answer, it.options) || answer;
  if (it.type === 'number') return String(parseFloat(String(answer).replace(/[^0-9.]/g, '')));
  return String(answer);
}

// Answers the owner gave up front live in profile/private.json (gitignored), never in code.
export const seedKnown = () => { for (const [q, a] of Object.entries(privateProfile().known_answers || {})) if (!one('SELECT answer FROM questions WHERE norm = ?', norm(q))?.answer) remember(q, a, 'owner'); };
export const seedQuestions = () => SEED.map((q) => unanswered(q, { source: 'setup' })).filter((q) => !q.answer);
export const minScore = () => config().min_score;
