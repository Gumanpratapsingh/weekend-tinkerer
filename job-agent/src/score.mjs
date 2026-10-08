// Scores how well a job fits the owner, 0-100, with an LLM. Cheap filters run before this (sources/common.mjs).
import { llm, master, config } from './core.mjs';

let profileCache;
function profile() {                                  // compact text profile (~350 tokens) to save free-tier budget
  if (profileCache) return profileCache;
  const m = master();
  profileCache = [
    `Software engineer, ${config().experience_years}+ years full-time (since Aug 2024), B.Tech CS 2024, currently in Chennai; open to any city in India (prefers Gurugram / Delhi NCR) or remote.`,
    ...m.experience.map((e) => `${e.title} @ ${e.org} (${e.dates}): ${e.bullets.map((b) => b.text).join(' ')}`),
    `Projects: ${m.projects.map((p) => `${p.name} [${p.stack}]`).join('; ')}`,
    `Skills: ${Object.values(m.skills).flat().join(', ')}`,
    'Does NOT have: Python ML production work, Kubernetes, Kafka, React, Go, team leadership.',
  ].join('\n');
  return profileCache;
}

const SYSTEM = `You screen jobs for one candidate whose goal is to land as many interviews as possible.
Score 0-100 = realistic chance this application gets a recruiter call.
- Experience: candidate has 2 years 2 months. Roles asking 0-3 years are a match; 3-4 years is a stretch that is still
  worth applying to (up to ~80 when the skills fit well); 5+ years or clearly senior/lead roles score below 40.
- Skills: missing a core must-have language/framework (e.g. the role is Python-only, Go-only, React-only) costs a lot;
  missing nice-to-haves or specific tools costs little.
- Role type: Java/Spring backend, full-stack Java, or AI/LLM application engineering are all good fits.
- Location: any city in India, or remote open to people in India, is fine. Give 0 if it needs living or working authorization outside India.
Return JSON: {"score":0-100,"track":"backend|ai","reasons":"<=25 words","blockers":["..."]}`;

export async function scoreJob(job) {
  const jd = `${job.title} at ${job.company}\nLocation: ${job.location}\n\n${String(job.description || '').slice(0, 3500)}`;
  const out = await llm([
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `CANDIDATE:\n${profile()}\n\nJOB:\n${jd}` },
  ], { json: true, maxTokens: 300, temperature: 0 });
  return {
    score: Math.max(0, Math.min(100, Math.round(Number(out.score) || 0))),
    track: out.track === 'ai' ? 'ai' : 'backend',
    reasons: [out.reasons, ...(out.blockers || []).map((b) => `✗ ${b}`)].filter(Boolean).join(' '),
  };
}
