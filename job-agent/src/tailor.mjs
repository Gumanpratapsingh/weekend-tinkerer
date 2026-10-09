// Tailors the resume to one job description, using only facts from profile/master.json.
// The LLM chooses order, emphasis and wording; validate() throws out any line that claims something new.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { llm, master, DATA, log } from './core.mjs';
import { resumeHtml } from './resume-html.mjs';
import { renderPdf } from './browser.mjs';

// Tech the owner does NOT have. If a rewrite mentions one of these (or any JD keyword) that its source bullet
// doesn't support, the rewrite is rejected and the original bullet is used.
const NOT_CLAIMED = ['python', 'pytorch', 'tensorflow', 'langchain', 'llamaindex', 'langgraph', 'kafka', 'rabbitmq',
  'kubernetes', 'k8s', 'docker', 'redis', 'react', 'vue', 'rust', 'c\\+\\+', 'c#', '\\.net', 'kotlin',
  'scala', 'spark', 'hadoop', 'airflow', 'gcp', 'azure', 'terraform', 'jenkins', 'ci/cd', 'mongodb', 'postgresql',
  'cassandra', 'dynamodb', 'eks', 'ecs', 'sagemaker', 'bedrock', 'hugging face', 'transformers', 'fine-tun\\w*',
  'rag', 'vector database', 'pinecone', 'embeddings', 'mlops', 'graphql', 'next\\.js', 'spring cloud',
  'spring security', 'django', 'flask', 'fastapi', 'snowflake', 'tableau', 'led a team', 'managed a team', 'mentored',
  // unverifiable scale/impact claims
  'high-volume', 'high volume', 'high-traffic', 'large-scale', 'at scale', 'millions?', 'thousands', 'billions?', 'enterprise-grade',
  'mission-critical', 'industry-leading', 'world-class', 'deep-learning', 'deep learning'];

const yearsOfExperience = () => {
  const yrs = (Date.now() - Date.UTC(2024, 7, 1)) / (365.25 * 86400e3);  // full-time since Aug 2024
  return `${Math.floor(yrs)}+`;
};

const hasTerm = (text, term) => new RegExp(`(^|[^a-z0-9])${term}([^a-z0-9]|$)`, 'i').test(text);
const numbers = (s) => (s.match(/\d+(?:\.\d+)?/g) || []);

function checkLine(rewrite, sourceText, allowed, jdTerms) {
  if (!rewrite || typeof rewrite !== 'string') return 'empty';
  if (rewrite.length > sourceText.length * 1.5 + 40) return 'too long';
  const okNums = new Set(numbers(sourceText).flatMap((n) => [n, n.split('.')[0]]));
  const badNum = numbers(rewrite).find((n) => !okNums.has(n));
  if (badNum) return `new number ${badNum}`;
  const basis = `${sourceText} ${allowed.join(' ')}`;
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const t of [...NOT_CLAIMED, ...jdTerms.map((k) => esc(k.toLowerCase()))]) {
    if (hasTerm(rewrite, t) && !hasTerm(basis, t)) return `unsupported "${t.replace(/\\/g, '')}"`;
  }
  return null;
}

export function validate(plan, m = master()) {
  const issues = [];
  const jdTerms = (plan.jd_keywords || []).filter((k) => typeof k === 'string' && k.length > 1).slice(0, 40);
  const allSkills = Object.values(m.skills).flat();
  const allFacts = [
    ...m.experience.flatMap((e) => e.bullets.flatMap((b) => [b.text, ...b.supports])),
    ...m.projects.flatMap((p) => [p.stack, ...p.bullets.flatMap((b) => [b.text, ...b.supports])]),
    ...allSkills, 'software engineer', 'backend', 'full-stack', 'developer', 'engineer',
  ];

  const pickBullets = (item, chosen) => {
    const byId = Object.fromEntries(item.bullets.map((b) => [b.id, b]));
    const out = [];
    for (const c of chosen || []) {
      const src = byId[c?.id];
      if (!src || out.some((o) => o.id === src.id)) continue;
      const why = checkLine(c.text, src.text, [...src.supports, item.stack || ''], jdTerms);
      if (why) issues.push(`${src.id}: ${why}`);
      out.push({ id: src.id, text: why ? src.text : c.text.trim() });
    }
    return out;
  };

  // Experience: every role, newest first, as in master. Bullets reordered/reworded; at least 2 per role.
  const experience = m.experience.map((role) => {
    const chosen = (plan.experience || []).find((e) => e.id === role.id)?.bullets;
    let bullets = pickBullets(role, chosen);
    for (const b of role.bullets) if (bullets.length < Math.min(2, role.bullets.length) && !bullets.some((x) => x.id === b.id)) bullets.push(b);
    return { ...role, bullets };
  });

  // Projects: the three the plan picked (falling back to the track defaults).
  const track = plan.track === 'ai' ? 'ai' : 'backend';
  let ids = (plan.projects || []).map((p) => p.id).filter((id) => m.projects.some((p) => p.id === id));
  for (const p of m.projects) if (ids.length < 3 && p.track.includes(track) && !ids.includes(p.id)) ids.push(p.id);
  const projects = ids.slice(0, 3).map((id) => {
    const proj = m.projects.find((p) => p.id === id);
    let bullets = pickBullets(proj, (plan.projects || []).find((p) => p.id === id)?.bullets);
    if (!bullets.length) bullets = proj.bullets.slice(0, 2);
    return { ...proj, bullets: bullets.slice(0, 3) };
  });

  // Skills: only skills that exist in master, in the order the plan prefers, the rest after.
  const skills = {};
  for (const [cat, list] of Object.entries(m.skills)) {
    const wanted = (plan.skills?.[cat] || []).map((s) => list.find((x) => x.toLowerCase() === String(s).toLowerCase())).filter(Boolean);
    const dropped = (plan.skills?.[cat] || []).filter((s) => !list.some((x) => x.toLowerCase() === String(s).toLowerCase()));
    if (dropped.length) issues.push(`skills ${cat}: dropped ${dropped.join(', ')}`);
    skills[cat] = [...new Set([...wanted, ...list])];
  }

  // Summary: must be supported by the facts as a whole; otherwise a plain default.
  const years = yearsOfExperience();
  const defaultSummary = track === 'ai'
    ? `Software engineer with ${years} years building Java/Spring Boot payment systems, who ships LLM-powered products: a real-time AI phone assistant and an autonomous job agent.`
    : `Backend engineer with ${years} years building Java/Spring Boot payment systems for 50+ banks, with a focus on performance, AWS and multi-tenant design.`;
  let summary = String(plan.summary || '').trim();
  const sWhy = summary && checkLine(summary, `${years.replace('+', '')} 50 ${allFacts.join(' ')}`, [], jdTerms);
  if (!summary || sWhy || summary.split(/\s+/).length > 45) { if (summary) issues.push(`summary: ${sWhy || 'too long'}`); summary = defaultSummary; }

  return { resume: { ...m, summary, experience, projects, skills, track }, issues };
}

const SYSTEM = `You tailor a software engineer's resume to a job description. You never invent anything.
Rules:
- Use ONLY facts in the candidate JSON. Do not add tools, numbers, team sizes, titles or responsibilities that are not there.
- You may reword a bullet to use the job description's vocabulary only when that bullet's own text or its "supports" list backs the term.
- Never add adjectives about scale, volume, traffic or impact ("high-volume", "large-scale", "millions") unless the fact says so.
- Keep each bullet one sentence, starting with a strong past-tense or present verb, at most about 30 words.
- Pick the bullets and the 3 projects most relevant to the job, most relevant first.
- Order skills within each category by relevance to the job; only list skills that are in the candidate's skills.
- "track" is "ai" if the role is mainly AI/ML/LLM/GenAI work, otherwise "backend".
Return JSON:
{"track":"backend|ai",
 "summary":"one or two sentences, <=40 words, facts only",
 "experience":[{"id":"<role id>","bullets":[{"id":"<bullet id>","text":"..."}]}],
 "projects":[{"id":"<project id>","bullets":[{"id":"<bullet id>","text":"..."}]}],
 "skills":{"<category>":["..."]},
 "jd_keywords":["up to 25 concrete tech/skill terms from the job description"],
 "missing":["must-have requirements of the job that the candidate does not show"]}`;

export async function planFor(job, m = master()) {
  const candidate = {
    years_experience: yearsOfExperience(),
    experience: m.experience.map((e) => ({ id: e.id, title: e.title, org: e.org, dates: e.dates, bullets: e.bullets })),
    projects: m.projects.map((p) => ({ id: p.id, name: p.name, stack: p.stack, bullets: p.bullets })),
    skills: m.skills,
  };
  const jd = `${job.title} at ${job.company} (${job.location || ''})\n\n${String(job.description || '').slice(0, 6000)}`;
  return llm([
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `CANDIDATE:\n${JSON.stringify(candidate)}\n\nJOB:\n${jd}` },
  ], { json: true, maxTokens: 2500, temperature: 0.2, why: `tailoring the resume for ${job.title} @ ${job.company}` });
}

// Full pipeline for one job: plan -> validate -> HTML -> PDF. Returns the PDF path.
export async function tailor(job) {
  const m = master();
  const { resume, issues } = validate(await planFor(job, m), m);
  if (issues.length) log(`tailor ${job.id}: kept originals for ${issues.join('; ')}`);
  const safe = `${job.company}-${job.title}`.replace(/[^a-z0-9]+/gi, '_').slice(0, 60);
  const base = join(DATA, 'resumes', `${safe}-${String(job.id).replace(/[^a-z0-9]/gi, '').slice(-10)}`);
  const html = resumeHtml(resume);
  writeFileSync(`${base}.html`, html);
  await renderPdf(`${base}.html`, `${base}.pdf`);
  return { pdf: `${base}.pdf`, track: resume.track, issues };
}

// Ready-made resume per track (no AI): original bullets, track default summary. Used for matches below
// tailor_min_score so the free AI budget goes to the strongest matches.
export async function baseResume(track = 'backend') {
  const { existsSync } = await import('node:fs');
  const pdf = join(DATA, 'resumes', `base-${track}.pdf`);
  if (existsSync(pdf)) return { pdf, track, issues: [] };
  const { resume } = validate({ track }, master());
  const html = pdf.replace(/\.pdf$/, '.html');
  writeFileSync(html, resumeHtml(resume));
  await renderPdf(html, pdf);
  return { pdf, track, issues: [] };
}
