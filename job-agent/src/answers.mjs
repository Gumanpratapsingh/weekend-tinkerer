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
  'May I tick standard "I acknowledge the candidate privacy notice / consent to processing my data for recruiting" boxes for you? (yes/no). NDAs and signatures will always be asked separately.',
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
const LEGAL = /\b(nda|non-?disclosure|confidential(ity)? agreement|e-?signature|signature|sign(ed)? (here|below)|type your (full|legal) name|i agree to the terms|arbitration)\b/i;

// Contact/profile fields answered straight from master.json (no AI call, never asked).
function direct(label, m) {
  const l = norm(label);
  const [first, ...rest] = m.name.split(' ');
  const rules = [
    [/country code|dial(l)?ing code|phone country/, 'India (+91)'],
    [/^(preferred )?first name|given name/, first], [/last name|surname|family name/, rest.join(' ')],
    [/^(full |your |legal )?name$|^name /, m.name], [/e ?mail/, m.contact.email], [/phone|mobile|contact number/, m.contact.phone.replace(/^\+?91[-\s]?/, '')],   // 10 digits; country code is its own field
    [/linkedin/, `https://${m.contact.linkedin}`], [/github/, `https://${m.contact.github}`],
    [/website|portfolio|personal (site|url)/, 'https://site.gumanpratap.workers.dev'],
    [/current (company|employer|organi[sz]ation)|^company$/, m.experience[0].org], [/current (job )?title|current (role|designation)/, m.experience[0].title],
    [/^(current )?(city|location)$|where are you (currently )?(based|located)/, m.contact.location],
    [/^country( of residence)?$/, 'India'], [/(school|university|college)( name)?$/, m.education[0].school],
    [/degree|highest (level of )?education|qualification/, "Bachelor's degree (B.Tech, Computer Science)"],
    [/graduation (date|year)|year of (graduation|passing)/, 'May 2024'], [/field of study|major|discipline/, 'Computer Science'],
  ];
  for (const [re, v] of rules) if (re.test(l)) return v;
  return null;
}

export async function resolve(items, context = '') {
  const known = all('SELECT id, question, answer FROM questions WHERE answer IS NOT NULL');
  const answers = {};
  const pending = [];
  const m0 = master();
  for (const it of items) {
    // A lone option mistaken for a question ("2-4 years", "Kotlin"): never ask the owner about it.
    if (it.options?.length === 1 && norm(it.options[0]) === norm(it.label)) continue;
    const d = direct(it.label, m0);
    if (d && fits(d, it)) { answers[it.key] = coerce(d, it); continue; }
    // Legal agreements are per company: only an exact earlier answer for this same job/company counts.
    if (LEGAL.test(it.label)) {
      it.label = `${it.label} (for ${context || 'this application'})`;
      const k = known.find((x) => norm(x.question) === norm(it.label));
      if (k) { answers[it.key] = coerce(k.answer, it); used(k.id); } else it.legal = true;
      continue;
    }
    const exact = known.find((k) => norm(k.question) === norm(it.label));
    const near = exact || known.map((k) => [k, similarity(k.question, it.label)]).filter(([, s]) => s >= 0.75).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (near && fits(near.answer, it)) { answers[it.key] = coerce(near.answer, it); used(near.id); }
    else pending.push(it);
  }
  const legalUnknown = items.filter((it) => it.legal);
  if (!pending.length) return { answers, unknown: legalUnknown };

  // One LLM call for everything left: match to known answers or derive from resume facts, else "UNKNOWN".
  const m = master();
  const facts = [
    `Name: ${m.name}. Email: ${m.contact.email}. Phone: ${m.contact.phone}. LinkedIn: https://${m.contact.linkedin}. GitHub: https://${m.contact.github}.`,
    `Education: ${m.education.map((e) => `${e.degree}, ${e.school}, ${e.dates}`).join('; ')}.`,
    `Current location: ${m.contact.location}. Phone country: India (+91).`,
    `Current: ${m.experience[0].title} at ${m.experience[0].org} since ${m.experience[0].dates.split('–')[0].trim()}; at ${m.experience[0].org} since Aug 2024.`,
    `Employment history (complete): ${m.experience.map((e) => `${e.title}, ${e.org}, ${e.dates}`).join('; ')}. Never worked for or contracted with any other company.`,
    'Citizenship: Indian, lives in India. Not authorized to work in the US or EU; holds no foreign visa. Not a citizen or resident of Cuba, Iran, North Korea, Syria or Crimea.',
    'Roles: back end and full stack (Java/Spring Boot + Angular). Comfortable with: Java, Python, Go, TypeScript, AWS, REST APIs, microservices, SQL. Not: Kotlin, Kubernetes, Terraform, React.',
    'Has worked in a fast-paced multi-tenant SaaS fintech (Finzly) and automated processes (batch jobs, AWS Lambda audit logging). Never founded a company.',
    `Skills: ${Object.values(m.skills).flat().join(', ')}.`,
  ].join('\n');
  let out = {};
  try {
    out = await llm([
      { role: 'system', content: `You fill a job application for the candidate. For each field, answer ONLY from the KNOWN ANSWERS or FACTS.
- If a known answer has the same meaning, adapt it to the field (e.g. pick the matching option, convert to a number).
- Yes/no skill questions ("Do you have experience with X?", "Have you built X?", "Walk me through an X you built" with
  Yes/No options) are answered from FACTS: "Yes" only if FACTS show it (he has built AI agents: the AI Call Assistant
  and an autonomous job-application agent).
- Years with a skill in FACTS: use full-time years since Aug 2024 (round down), unless a known answer says otherwise.
- Anything personal (salary, notice, visa, relocation, demographics, references, cover letters, opinions) that is not in KNOWN ANSWERS: "UNKNOWN".
- "About yourself" / short introduction: 2-3 sentences written ONLY from FACTS (role, years, stack, one project).
- Compensation / salary expectation questions: use the expected CTC from KNOWN ANSWERS (convert units if the field asks).
- Multi-select experience/skills lists: select only the options the FACTS support.
- Work authorization / visa sponsorship for roles in INDIA or remote-from-India: authorized = Yes (Indian citizen), sponsorship = No.
  For questions explicitly about the US/EU: authorized = No.
- Legal agreements, NDAs, confidentiality terms, or e-signatures (e.g. "type your full name to sign"): ALWAYS "UNKNOWN".
- Pronouns and gender: ONLY from KNOWN ANSWERS. Never infer them from the name. Otherwise pick the
  "prefer not to say / decline" option if there is one, else "UNKNOWN".
- Multi-select questions ("select all that apply"): answer with the matching options separated by " | ".
- US voluntary self-identification (EEO): veteran status -> the "not a protected veteran" option (he never served in
  the US military); disability, race, ethnicity, Hispanic/Latino -> the "decline to self-identify / don't wish to answer"
  option, unless KNOWN ANSWERS has the owner's own answer. Gender: KNOWN ANSWERS, else the decline option.
- Privacy-notice acknowledgement / data-processing consent: "Yes" (or the matching agree option) only if KNOWN ANSWERS says the owner allows it; otherwise "UNKNOWN".
- For choice fields the answer must be exactly one of the options, or "UNKNOWN". Fields marked "long_list" (countries etc.)
  have too many options to show: answer with the plain value (e.g. "India") and it will be matched.
- "Have you worked for / been employed by <company>?": answer from the employment history in FACTS.
Return JSON {"<key>": "<answer or UNKNOWN>"}.` },
      { role: 'user', content: `FACTS:\n${facts}\n\nKNOWN ANSWERS:\n${known.map((k) => `Q: ${k.question}\nA: ${k.answer}`).join('\n')}\n\n`
        + `CONTEXT: ${context}\n\nFIELDS:\n${JSON.stringify(pending.map(({ key, label, type, options }) =>
          (options?.length > 40 ? { key, label, type: 'long_list' } : { key, label, type, options })))}` },
    ], { json: true, maxTokens: 900, temperature: 0, why: `answering ${pending.length} form question(s) from your memory` });
  } catch (e) {
    // AI unavailable (free-tier rate limit): retry the application later; never turn this into questions for the owner.
    log(`resolve llm: ${e.message}`);
    const err = new Error('AI busy, retry later'); err.retryLater = true; throw err;
  }

  const unknown = [...legalUnknown];
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
  return options.find((o) => norm(o) === a) || options.find((o) => norm(o).startsWith(a) || (norm(o).length > 1 && a.startsWith(norm(o))))
    || options.find((o) => norm(o).split(' ').includes(a));
}
function coerce(answer, it) {
  if (it.options?.length) return pickOption(answer, it.options) || answer;
  // Number-only fields (CTC in lakhs, years, notice days): "15-16 LPA fixed" -> "16", "2+ years" -> "2".
  if (!/phone|mobile|contact/i.test(it.label)
      && /ctc|salary|compensation|lacs?|lakhs?|lpa|years?|experience|notice|days|months|number|how many|gpa|cgpa|percentage/i.test(it.label)
      && /^\D{0,12}\d+(\.\d+)?(\s*(-|to|–)\s*\d+(\.\d+)?)?\D{0,25}$/.test(String(answer).trim())) {
    const nums = String(answer).match(/\d+(\.\d+)?/g).map(Number);
    return String(/ctc|salary|compensation|lacs?|lakhs?|lpa/i.test(it.label) ? Math.max(...nums) : nums[0]);
  }
  if (it.type === 'number') return String(parseFloat(String(answer).replace(/[^0-9.]/g, '')));
  return String(answer);
}

// Answers the owner gave up front live in profile/private.json (gitignored), never in code.
export const seedKnown = () => { for (const [q, a] of Object.entries(privateProfile().known_answers || {})) if (!one('SELECT answer FROM questions WHERE norm = ?', norm(q))?.answer) remember(q, a, 'owner'); };
export const seedQuestions = () => SEED.map((q) => unanswered(q, { source: 'setup' })).filter((q) => !q.answer);
export const minScore = () => config().min_score;
