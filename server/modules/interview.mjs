// Interview prep coach: one question every morning, answered on the hub page (or by sending the
// answer to ntfy "<topic>-iq"), graded by Groq. Weak topics come back more often; Sunday recap.
import { randomUUID } from 'node:crypto';
import { load, save, push, listen, groq, daily, istDate, log } from '../core.mjs';

const TOPICS = ['Java core', 'Java concurrency', 'Spring Boot', 'JPA / Hibernate', 'SQL & query tuning', 'REST API design',
  'Microservices', 'System design', 'AWS', 'Kafka & messaging', 'Kubernetes & Docker', 'DSA', 'Payments domain', 'Behavioural'];
const LEVEL = 'engineer with about 2 years of experience in Java/Spring Boot payments systems, aiming for a mid-level role';

let data = load('interview.json', { questions: [] });
const persist = () => save('interview.json', data);

// Weight topics: unanswered and low-scoring ones come back sooner (simple spaced repetition).
function pickTopic() {
  const stats = Object.fromEntries(TOPICS.map((t) => [t, { n: 0, sum: 0 }]));
  for (const q of data.questions) if (q.score && stats[q.topic]) { stats[q.topic].n++; stats[q.topic].sum += q.score; }
  const recent = new Set(data.questions.slice(-4).map((q) => q.topic));
  const weights = TOPICS.map((t) => {
    const s = stats[t]; const avg = s.n ? s.sum / s.n : 2.5;
    return recent.has(t) ? 0.2 : (6 - avg) + (s.n ? 0 : 1.5);
  });
  let r = Math.random() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < TOPICS.length; i++) { r -= weights[i]; if (r <= 0) return TOPICS[i]; }
  return TOPICS[0];
}

async function newQuestion() {
  const topic = pickTopic();
  const asked = data.questions.filter((q) => q.topic === topic).slice(-15).map((q) => q.question);
  const out = await groq([{ role: 'user', content:
    `Write one interview question on "${topic}" for a ${LEVEL}. It should be answerable in 5-10 sentences,
practical, and commonly asked in Indian product/fintech interviews. Do not repeat any of these: ${JSON.stringify(asked)}.
Reply as JSON {"question": "..."}` }], { json: true, maxTokens: 500, temperature: 0.9 });
  const q = { id: randomUUID(), date: istDate(), topic, question: String(out.question).trim() };
  data.questions.push(q); persist();
  await push(`Interview question: ${topic}`, `${q.question}\n\nAnswer on your hub (/interview) or reply in ntfy.`, { tags: 'mortar_board' });
  return q;
}

async function grade(q, answer) {
  const out = await groq([{ role: 'user', content:
    `You are a friendly but honest interviewer for a ${LEVEL}.
Question (${q.topic}): ${q.question}
Candidate's answer: ${answer}
Grade 1-5 (5 = would clearly pass). Reply as JSON:
{"score": n, "good": "what was right, 1-2 sentences", "missing": "key gaps, 1-3 short points",
 "model": "a strong model answer in 5-8 sentences"}` }], { json: true, maxTokens: 1500 });
  Object.assign(q, { answer: answer.slice(0, 4000), score: Math.max(1, Math.min(5, Math.round(out.score))),
    good: out.good, missing: out.missing, model: out.model, answeredAt: Date.now() });
  persist();
  log(`interview graded ${q.topic} ${q.score}`);
  return q;
}

const today = () => [...data.questions].reverse().find((q) => q.date === istDate());

async function weeklyRecap() {
  const since = istDate(Date.now() - 6 * 86400e3);
  const week = data.questions.filter((q) => q.date >= since && q.score);
  if (!week.length) return push('Interview week', 'No answers this week. One question a day adds up!', { tags: 'mortar_board' });
  const avg = (week.reduce((s, q) => s + q.score, 0) / week.length).toFixed(1);
  const weakest = [...week].sort((a, b) => a.score - b.score).slice(0, 2).map((q) => q.topic).join(', ');
  await push('Interview week recap', `${week.length} answered, average ${avg}/5.\nFocus next week: ${weakest}.`, { tags: 'bar_chart' });
}

export default {
  start() {
    daily(9, 0, async () => { if (!today()) await newQuestion(); });
    daily(20, 0, weeklyRecap, { days: [0] });
    // A reply on ntfy answers today's question.
    listen('iq', async (text) => {
      const q = today();
      if (!q) return push('No question yet', 'Today\'s question arrives at 9 AM.');
      const g = await grade(q, text);
      await push(`Score ${g.score}/5: ${g.topic}`, `Good: ${g.good}\nMissing: ${g.missing}\n\nFull model answer on your hub.`, { tags: 'mortar_board' });
    });
  },
  routes: {
    'GET /api/interview': () => {
      const scored = data.questions.filter((q) => q.score);
      const byTopic = {};
      for (const q of scored) (byTopic[q.topic] ||= []).push(q.score);
      return {
        today: today() || null,
        history: [...data.questions].reverse().slice(0, 60),
        topics: Object.entries(byTopic).map(([topic, s]) => ({ topic, n: s.length, avg: s.reduce((a, b) => a + b, 0) / s.length }))
          .sort((a, b) => a.avg - b.avg),
      };
    },
    'POST /api/interview/new': () => newQuestion(),
    'POST /api/interview/answer': async ({ body }) => {
      const q = data.questions.find((x) => x.id === body.id) || today();
      const answer = String(body.answer || '').trim();
      if (!q || answer.length < 20) throw Object.assign(new Error('Write at least a couple of sentences.'), { status: 400, expose: true });
      return grade(q, answer);
    },
  },
};
