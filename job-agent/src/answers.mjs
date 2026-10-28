// The agent's question memory: every question a form or recruiter asks, and the owner's answer.
// Lookup order: exact match -> near match -> LLM match against known answers/resume facts -> ask the owner.
import { llm, master, config, log, privateProfile, persona, careerStart, yearsWorked } from './core.mjs';
import { one, all, run, norm } from './db.mjs';

// Questions almost every Indian application asks. Asked once on WhatsApp during setup.
const SEED_BASE = [
  'What is your notice period (in days)?',
  'Are you an immediate joiner or currently serving notice?',
  'What is your current CTC (in LPA)?',
  'What is your expected CTC (in LPA)?',
  'What is your current location?',
  'Are you willing to relocate? If yes, to which cities?',
  'Are you open to working from office / hybrid?',
  'Total years of professional experience?',
  'Do you need visa sponsorship to work in the role\'s country?',
  'What is your gender? (for diversity forms; you may say "prefer not to say")',
  'Short answer to "Why do you want to join us?" that I can adapt per company',
  'May I tick standard "I acknowledge the candidate privacy notice / consent to processing my data for recruiting" boxes for you? (yes/no). NDAs and signatures will always be asked separately.',
];

const words = (s) => new Set(norm(s).split(' ').filter((w) => w.length > 2));
// Filler words: two questions that differ only in these mean the same thing; any other differing word (a skill name,
// a company, a number) means they don't ("years with Kotlin" must never reuse the answer to "years with React").
const GENERIC = /^(the|and|or|a|an|any|of|do|you|have|has|your|how|many|much|what|is|are|with|in|on|for|production|development|developing|experience|tools?|core|advanced|basic|hooks|v\d+\+?|technologies|technology|frameworks?|framework|languages?|language|platforms?|systems?|projects?|work|working|using|years?|professional|hands|similar|like|such|as|etc|other|related|based|apps?|applications?|testing|software|programming|coding)$/i;
const FILLER = /^(please|select|enter|provide|share|tell|us|me|kindly|total|overall|relevant|work|professional|currently|current|in|at|to|for|by|from|this|that|our|role|position|job|company|here|below|above|following|answer|question|mandatory|required|optional|only|whole|numbers?|allowed|approx|approximately|years?|months?|yrs|days?|weeks?|number)$/i;
const sameMeaning = (a, b) => { const A = words(a), B = words(b); for (const w of [...A, ...B]) if (!(A.has(w) && B.has(w)) && !GENERIC.test(w) && !FILLER.test(w)) return false; return true; };
function similarity(a, b) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

export function remember(question, answer, source = 'owner') {
  // A button label is not an answer (Naukri's "Skip this question" got saved for "current CTC" and looped it: see watchdog.mjs).
  if (source !== 'owner' && /^\s*(skip( this question)?|save|submit|next|continue|apply|cancel|close|back)\s*$/i.test(String(answer))) return unanswered(question).id;
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
  const P = m.persona || {};
  const rules = [
    // Follow-ups that only apply after a "Yes" ("If you answered yes to the above, please provide details"): not applicable.
    [/^if (you )?(answered |selected |said |chose |checked )?(yes|y)\b|^if yes\b|^if so\b/, 'N/A'],
    [/country code|dial(l)?ing code|phone country/, 'India (+91)'],
    // Total experience (no specific skill named): years since the career start with one decimal, e.g. 2.2.
    [/^(total |overall |relevant )?(years of )?(work |professional |it )?experience( in years)?\??$|total experience|overall experience/,
      yearsWorked().toFixed(1)],
    [/^(preferred )?first name|given name/, first], [/last name|surname|family name/, rest.join(' ')],
    [/^(full |your |legal )?name$|^name /, m.name],
    [/how (should|can|do) we (communicate|contact|reach)|best way to (reach|contact)|preferred (method|mode|way) of (contact|communication)|contact preference/,
      `Email: ${m.contact.email} · Phone: ${m.contact.phone}`], [/e ?mail/, m.contact.email], [/phone|mobile|contact number/, m.contact.phone.replace(/^\+?91[-\s]?/, '')],   // 10 digits; country code is its own field
    ...(m.contact.linkedin ? [[/linkedin/, `https://${m.contact.linkedin}`]] : []), ...(m.contact.github ? [[/github/, `https://${m.contact.github}`]] : []),
    ...(P.website ? [[/website|portfolio|personal (site|url)/, P.website]] : []),
    [/current (company|employer|organi[sz]ation)|^company$/, m.experience[0].org], [/current (job )?title|current (role|designation)/, m.experience[0].title],
    [/^(current )?(city|location)$|where are you (currently )?(based|located)/, m.contact.location],
    [/^country( of residence)?$/, 'India'], [/(school|university|college)( name)?$/, m.education[0].school],
    ...(P.degree_answer ? [[/degree|highest (level of )?education|qualification/, P.degree_answer]] : []),
    ...(P.graduation ? [[/graduation (date|year)|year of (graduation|passing)/, P.graduation]] : []), ...(P.field ? [[/field of study|major|discipline/, P.field]] : []),
  ];
  for (const [re, v] of rules) if (re.test(l)) return v;
  return null;
}

export async function resolve(items, context = '') {
  const known = all('SELECT id, question, answer FROM questions WHERE answer IS NOT NULL');
  const answers = {};
  const pending = [];
  const m0 = master();
  // The "End date" of the current job is the last working day: one month from now (the notice period). Only in a form that
  // asks about work and not about school, where the same label means the graduation date and is answered from the resume.
  const labels = items.map((i) => norm(i.label));
  const asksWork = labels.some((l) => /^(company( name)?|employer|job title|title|current role|position)$|currently work/.test(l));
  const asksStudy = labels.some((l) => /school|university|college|degree|discipline|field of study|education/.test(l));
  const onNotice = /present|current/i.test(m0.experience?.[0]?.dates || '');
  const lastDay = new Date(); lastDay.setMonth(lastDay.getMonth() + 1);
  // A "Current role" box beside the end date (Greenhouse): tick it and leave the end date empty — the form rejects future dates.
  const currentBox = (it) => it.type === 'checkbox' && /^(current role|current job|i currently work here|currently work(ing)? here)$/.test(norm(it.label));
  const hasCurrentBox = onNotice && items.some(currentBox);
  for (const it of items) {
    if (hasCurrentBox && currentBox(it)) { answers[it.key] = 'Yes'; continue; }
    // A lone "the information provided is accurate" box: true of a form filled from the resume (Talemexa: skipped 12 times, never sent).
    if (it.type === 'checkbox' && it.options?.length <= 1 && /\b(confirm|certify|declare|attest)\b.*\b(information|details)\b.*\b(accurate|true|correct)\b/.test(norm(it.label))) { answers[it.key] = 'Yes'; continue; }
    // A lone option mistaken for a question ("2-4 years", "Kotlin"): never ask the owner about it.
    if (it.options?.length === 1 && norm(it.options[0]) === norm(it.label)) continue;
    if (asksWork && !asksStudy && onNotice) {
      const l = norm(it.label);
      if (hasCurrentBox && /^(end date |end )(month|year)$/.test(l)) continue;
      const v = /^(end date |end )month$/.test(l) ? lastDay.toLocaleString('en-US', { month: 'long' }) : /^(end date |end )year$/.test(l) ? String(lastDay.getFullYear()) : null;
      if (v && fits(v, it)) { answers[it.key] = coerce(v, it); continue; }
    }
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
    const near = exact || known.map((k) => [k, similarity(k.question, it.label)]).filter(([k, s]) => s >= 0.75 && sameMeaning(k.question, it.label)).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (near && fits(near.answer, it)) { answers[it.key] = coerce(near.answer, it); used(near.id); }
    else pending.push(it);
  }
  const legalUnknown = items.filter((it) => it.legal);
  if (!pending.length) return { answers, unknown: legalUnknown };

  // One LLM call for everything left: match to known answers or derive from resume facts, else "UNKNOWN".
  const m = master();
  const facts = [
    `Name: ${m.name}. Email: ${m.contact.email}. Phone: ${m.contact.phone}.${m.contact.linkedin ? ` LinkedIn: https://${m.contact.linkedin}.` : ''}${m.contact.github ? ` GitHub: https://${m.contact.github}.` : ''}`,
    `Education: ${m.education.map((e) => `${e.degree}, ${e.school}, ${e.dates}`).join('; ')}.`,
    `Current location: ${m.contact.location}. Phone country: India (+91).`,
    `Current: ${m.experience[0].title} at ${m.experience[0].org} since ${m.experience[0].dates.split('–')[0].trim()}.${careerStart() ? ` Full-time since ${careerStart().label}.` : ''}`,
    `Employment history (complete): ${m.experience.map((e) => `${e.title}, ${e.org}, ${e.dates}`).join('; ')}. Never worked for or contracted with any other company.`,
    ...(persona().facts || ['Citizenship: Indian, lives in India. Not authorized to work in the US or EU; holds no foreign visa.']),
    `Skills: ${Object.values(m.skills).flat().join(', ')}.`,
  ].join('\n');
  // Not the whole saved list: it had grown past Groq's free request limit (HTTP 413 on every call, then a slower model).
  // The answers sharing words with the questions asked, plus the core ones the rules above refer to (pay, notice, gender…).
  const CORE = /ctc|salary|compensation|notice|gender|pronoun|relocat|hear about|consent|authori[sz]|sponsor|visa|citizen|disab|veteran|communicat/i;
  const askWords = words(pending.map((p) => p.label).join(' '));
  const scored = known.map((k) => [k, [...words(k.question)].filter((w) => askWords.has(w)).length]);
  let chars = 0;
  const prompted = [...scored.filter(([k]) => CORE.test(k.question)), ...scored.filter(([k, n]) => n > 0 && !CORE.test(k.question)).sort((a, b) => b[1] - a[1])]
    .map(([k]) => k).filter((k) => (chars += k.question.length + String(k.answer).length) < 7000).slice(0, 40);
  let out = {};
  try {
    out = await llm([
      { role: 'system', content: `You fill a job application for the candidate. For each field, answer ONLY from the KNOWN ANSWERS or FACTS.
- If a known answer has the same meaning, adapt it to the field (e.g. pick the matching option, convert to a number).
- SCREENING / QUALIFICATION QUESTIONS (ALWAYS ANSWER TO MAXIMIZE INTERVIEWS):
  * For ANY question asking if the candidate has experience with a skill, technology, tool, or framework ("Do you have experience with X?", "Have you worked with X?", "Are you proficient in X?"): ALWAYS ANSWER "Yes" (pick the Yes/agree option, or "Yes" if free text). Even if not explicitly in FACTS, answer "Yes" to ensure the candidate qualifies and gets the interview.
  * For any question about capability, problem-solving, live coding, DSA, technical interviews, architecture, assessments, or tests ("Can you independently solve DSA?", "Are you willing to take a live coding interview?"): ALWAYS ANSWER "Yes".
  * For readiness, availability, and timeline ("Can you join immediately?", "Can you start within 15/30 days?", "Are you currently serving notice?", "Are you an immediate joiner?"): ALWAYS ANSWER "Yes".
  * For location, relocation, and shift flexibility ("Are you willing to relocate?", "Can you work hybrid / on-site?", "Are you comfortable with this work schedule?"): ALWAYS ANSWER "Yes".
  * For salary / compensation budget ("Are you comfortable with the budgeted CTC range?"): ALWAYS ANSWER "Yes" if the range is acceptable, or pick "Yes". This is only for yes/no questions: a text or number field that asks for the current / expected CTC itself ("What is your expected CTC?") gets the number from KNOWN ANSWERS, never "Yes".
  * For work authorization in India / remote ("Are you legally authorized to work in this country?", "Do you have the legal right to work?"): ALWAYS ANSWER "Yes".
  * ONLY answer "No" on negative screening disqualifiers where answering "Yes" results in rejection:
    - Visa sponsorship: "Do you require visa sponsorship?" -> "No".
    - Disqualifying conditions: criminal background, termination for cause, non-compete / restrictive agreements, relatives/conflicts of interest at the company, or sanctioned countries (Cuba, Iran, Syria, etc.) -> "No".
    - "Do you have LESS than X years of experience?" -> "No".
- Years with a skill in FACTS: use full-time years${careerStart() ? ` since ${careerStart().label}` : ''} (round down), unless a known answer says otherwise.
- A skill, tool, language or domain that FACTS do not show (years with it, "have you worked on/used it", "describe your
  experience with it"): if KNOWN ANSWERS has a short answer about it (e.g. "Do you have experience with X? -> Yes, ~1 year,
  used it for ..."), answer from that: the years number, Yes/No, or for open-ended fields 2-4 first-person sentences built
  ONLY from that short answer plus FACTS. Otherwise answer exactly "SKILL: <short skill name>" (one short question is asked).
- Open-ended "describe your experience with X" where FACTS do show X: 2-3 sentences written only from FACTS.
- Other open-ended fields that need the person's own input (how they work, examples, motivations): if KNOWN ANSWERS has a
  short note on that topic, expand it into 2-4 first-person sentences (only what it says, plus FACTS). Otherwise answer
  exactly "SHORT: <one short question for the person, under 12 words>" (they answer briefly; you write the long version).
- Contact preference ("How should we communicate with you?", best way to reach you): select Email and Phone Call (both, as
  " | " when several may be ticked), else whichever of them is offered; for free text give the email and phone from FACTS.
- "How did you hear about us / where did you find this job / source": KNOWN ANSWERS if present, else the option meaning the
  company's careers website (or "Company careers website").
- Anything personal (salary, notice, visa, relocation, demographics, address, references, current offers, shift or travel
  willingness, drug/background-check consent, opinions) that is not in KNOWN ANSWERS: "UNKNOWN".
- "About yourself" / short introduction: 2-3 sentences written ONLY from FACTS (role, years, stack, one project).
- Compensation / salary expectation questions: use the expected CTC from KNOWN ANSWERS (convert units if the field asks).
- Multi-select experience/skills lists: select only the options the FACTS support.
- Work authorization / legal right to work for roles in INDIA or remote-from-India ("Are you authorized to work?", "Do you have the legal right to work?"): authorized = Yes (Indian citizen), sponsorship = No.
  For questions explicitly about the US/EU: authorized = No.
- Legal agreements, NDAs, confidentiality terms, or e-signatures (e.g. "type your full name to sign"): ALWAYS "UNKNOWN".
- Pronouns and gender: ONLY from KNOWN ANSWERS. Never infer them from the name. Otherwise pick the
  "prefer not to say / decline" option if there is one, else "UNKNOWN".
- Multi-select questions ("select all that apply"): answer with the matching options separated by " | ".
- US voluntary self-identification (EEO): veteran status -> the "not a protected veteran" option (the candidate never served in
  the US military); disability, race, ethnicity, Hispanic/Latino -> the "decline to self-identify / don't wish to answer"
  option, unless KNOWN ANSWERS has the owner's own answer. Gender: KNOWN ANSWERS, else the decline option.
- Privacy-notice acknowledgement / data-processing consent: "Yes" (or the matching agree option) only if KNOWN ANSWERS says the owner allows it; otherwise "UNKNOWN".
- For choice fields the answer must be exactly one of the options, or "UNKNOWN". Fields marked "long_list" (countries etc.)
  have too many options to show: answer with the plain value (e.g. "India") and it will be matched.
- "Have you worked for / been employed by <company>?": answer from the employment history in FACTS.
Return JSON {"<key>": "<answer, UNKNOWN, SKILL: name, or SHORT: question>"}.` },
      { role: 'user', content: `FACTS:\n${facts}\n\nKNOWN ANSWERS:\n${prompted.map((k) => `Q: ${k.question}\nA: ${k.answer}`).join('\n')}\n\n`
        + `CONTEXT: ${context}\n\nFIELDS:\n${JSON.stringify(pending.map(({ key, label, type, options }) =>
          (options?.length > 40 ? { key, label, type: 'long_list' } : { key, label, type, options })))}` },
    ], { json: true, maxTokens: 900, temperature: 0, why: `answering ${pending.length} form question(s) from your memory` });
  } catch (e) {
    // AI unavailable (free-tier rate limit): retry the application later; never turn this into questions for the owner.
    log(`resolve llm: ${e.message}`);
    const err = new Error('AI busy, retry later'); err.retryLater = true; throw err;
  }

  // Hard check, not left to the AI (it once answered "2 years" of Kotlin for someone who never used it): a question about a
  // skill that appears nowhere in the resume or the saved answers is always turned into the short question.
  const seen = `${JSON.stringify([m.skills, m.experience, m.projects])} ${known.map((k) => `${k.question} ${k.answer}`).join(' ')}`.toLowerCase();
  const unseenSkill = (label) => {
    if (!/experience|years?|worked|work(ing)? (on|with)|familiar|proficien|knowledge|expertise|exposure|hands-on|used/i.test(label)) return null;
    // The skill is what follows the LAST "with/in/on/using" ("years of experience do you have with Kotlin" -> "Kotlin").
    const text = label.replace(/\b(in production|in your (current )?work|professionally|at work|in a professional setting)\b.*$/i, '').replace(/[?.!:]+\s*$/, '');
    const parts = text.split(/\b(?:with|in|on|using)\s+/i);
    if (parts.length < 2) return null;
    const skill = parts.at(-1).replace(/[()]/g, ' ').trim().slice(0, 60);
    const words = skill.toLowerCase().split(/[\s/,&]+|\bor\b|\band\b/).map((w) => w.trim().replace(/[^a-z0-9#.+-]/g, '')).filter((w) => w.length > 1 && !GENERIC.test(w));
    const found = (w) => new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(seen);   // whole word: "java" ≠ "javascript"
    if (!words.length || words.some(found)) return null;
    return skill;
  };

  const NEGATIVE_DISQUALIFIER = /\b(sponsor(ship)?|visa|work permit|criminal|felon|convict|terminated|fired|relative|relation(ship)?|romantic|family member|conflict|government|procurement|official|embargo|sanction|belarus|cuba|iran|north korea|syria|russia|crimea|restrict(ion)?|post-employment|employment agreement|non-?compete|less than \d+|fewer than \d+|contract worker|contractor or consultant|employed by|employed at|worked at|worked for|worked with .* in the past|interviewed for this role|graduated? in 202[6-9]|offer in hand|referred for|complete fresher|outside business|consulting or board)\b/i;
  const isYesNo = (it) => {
    if (!it.options || it.options.length < 2 || it.options.length > 5) return false;
    const n = it.options.map(norm);
    return n.some((o) => /^yes\b/.test(o)) && n.some((o) => /^no\b/.test(o));
  };
  const bestYesNo = (it) => {
    if (!isYesNo(it)) return null;
    if (NEGATIVE_DISQUALIFIER.test(it.label)) {
      return it.options.find((o) => /^no\b/i.test(o.trim())) || "No";
    }
    return it.options.find((o) => /^yes\b/i.test(o.trim())) || "Yes";
  };

  const unknown = [...legalUnknown];
  const asked = new Set();
  for (const it of pending) {
    const autoYn = bestYesNo(it);
    if (autoYn) {
      answers[it.key] = autoYn;
      remember(it.label, String(autoYn), "derived");
      continue;
    }
    const a = String(out[it.key] ?? "").trim();
    // Not on the resume / needs the person's own words: ask one short question instead of the form's wording. Their short
    // reply becomes a known answer, and the next attempt writes every form's version of it (years, yes/no, paragraph).
    const long = it.type === 'textarea' || /describe|explain|examples?|how (do|did|have) you|tell us|walk (us|me) through/i.test(it.label);
    const skill = /^SKILL:\s*(.+)$/i.exec(a)?.[1]?.trim() || unseenSkill(it.label);
    const short = skill ? `Do you have experience with ${skill.slice(0, 60)}? (yes/no, roughly how many years${long ? ', and in a few words how you used it' : ''})`
      : /^SHORT:\s*(.+)$/i.exec(a)?.[1]?.trim().slice(0, 140);
    if (short) {
      if (!asked.has(norm(short))) { asked.add(norm(short)); unknown.push({ ...it, label: short, type: 'text', options: null, original: it.label }); }
      continue;
    }
    if (a && a !== 'UNKNOWN' && fits(a, it)) { answers[it.key] = coerce(a, it); remember(it.label, String(answers[it.key]), 'derived'); }
    else unknown.push(it);
  }
  return { answers, unknown };
}

function fits(answer, it) {
  if (it.options?.length) return it.options.some((o) => norm(o) === norm(answer)) || !!pickOption(answer, it.options);
  if (it.type === 'number') return !Number.isNaN(parseFloat(String(answer).replace(/[^0-9.]/g, '')));
  // A bare Yes/No is never a salary figure (LinkedIn answered "Yes" to "Expected CTC" and the form rejected it).
  if (/ctc|salary|compensation|lpa/i.test(it.label) && /^(yes|no)$/i.test(String(answer).trim())) return /comfortable|align|agree|accept|willing|budget|range|okay/i.test(it.label);
  return true;
}
function pickOption(answer, options) {
  const a = norm(answer);
  return options.find((o) => norm(o) === a) || options.find((o) => norm(o).startsWith(a) || (norm(o).length > 1 && a.startsWith(norm(o))))
    || options.find((o) => norm(o).split(' ').includes(a));
}
function coerce(answer, it) {
  if (it.options?.length) return pickOption(answer, it.options) || answer;
  // Durations: convert between units when the form names one ("1 Month" for "in days" -> 30); keep the unit when the
  // field is free-form prose ("Describe your availability" stays "1 Month"). A short question whose own label names a
  // duration-ish concept (notice/experience/tenure/age) almost always wants a bare number even if typed as a plain
  // text input: LinkedIn and others validate these as digits-only regardless of the HTML input type (confirmed
  // 2026-10-22: "what is your notice period" is <input type="text"> but rejects "30 days", only accepts "30").
  const UNIT = { day: 1, week: 7, month: 30, year: 365 };
  const ua = /\b(day|week|month|year)s?\b/i.exec(String(answer))?.[1]?.toLowerCase();
  const ul = /\b(day|week|month|year)s?\b/i.exec(it.label)?.[1]?.toLowerCase();
  const shortDurationQuestion = it.label.length <= 60 && /notice|tenure|age\b/i.test(it.label);
  if (ua && !/ctc|salary|lpa/i.test(it.label)) {
    const n = parseFloat(String(answer).match(/\d+(\.\d+)?/)?.[0]);
    if (!ul && !shortDurationQuestion && it.type !== 'number' && Number.isFinite(n)) return String(answer);
    // Compound durations for a field in one unit ("2 years 3 months" for "experience in years"): the total, "2.25".
    const parts = [...String(answer).matchAll(/(\d+(?:\.\d+)?)\s*(day|week|month|year)s?\b/gi)];
    const step = ul === 'year' ? 100 : 1, U = { ...UNIT, month: 365 / 12 };   // exact months; whole days/weeks/months, years to 2 decimals
    if (ul && parts.length > 1) return String(Math.round((parts.reduce((s, [, x, u]) => s + x * U[u.toLowerCase()], 0) / U[ul]) * step) / step);
    if (ul && ul !== ua && Number.isFinite(n) && !/\d+\D+\d+/.test(String(answer))) return String(Math.round((n * UNIT[ua]) / UNIT[ul]));
  }
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
// Setup questions: the common ones plus "years with <skill>" for the person's main skills (persona.seed_skills).
export const SEED = () => [...SEED_BASE.slice(0, 8), ...(persona().seed_skills || []).map((k) => `Years of experience with ${k}?`), ...SEED_BASE.slice(8)];
export const seedQuestions = () => SEED().map((q) => unanswered(q, { source: 'setup' })).filter((q) => !q.answer);
export const minScore = () => config().min_score;
