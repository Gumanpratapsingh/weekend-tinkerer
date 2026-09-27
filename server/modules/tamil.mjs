// Tamil phrase of the day for everyday Chennai life, with a themed week and a Sunday quiz.
import { load, save, push, groq, daily, istDate, istNow } from '../core.mjs';

const THEMES = ['Greetings & politeness', 'Auto & directions', 'Shopping & bargaining', 'Food & restaurants',
  'Numbers & money', 'Office small talk', 'Neighbours & home', 'Emergencies & health', 'Time & days', 'Feelings & reactions'];

let data = load('tamil.json', { phrases: [] });
const persist = () => save('tamil.json', data);
const weekTheme = () => THEMES[Math.floor(Date.now() / (7 * 86400e3)) % THEMES.length];

async function newPhrase() {
  const theme = weekTheme();
  const used = data.phrases.slice(-80).map((p) => p.transliteration);
  const p = await groq([{ role: 'user', content:
    `Give one practical spoken Tamil phrase (Chennai colloquial, not literary) for a non-Tamil speaker, theme "${theme}".
Avoid these: ${JSON.stringify(used)}. Reply as JSON:
{"tamil": "Tamil script", "transliteration": "easy English-letter pronunciation", "meaning": "English meaning",
 "when": "one sentence on when to use it", "reply": "a likely reply with transliteration and meaning"}` }],
  { json: true, maxTokens: 700, temperature: 0.8 });
  const phrase = { date: istDate(), theme, ...p };
  data.phrases.push(phrase); persist();
  await push(`Tamil: ${phrase.transliteration}`, `${phrase.tamil}\n= ${phrase.meaning}\n${phrase.when}`, { tags: 'speech_balloon' });
  return phrase;
}

async function sundayQuiz() {
  const week = data.phrases.slice(-6);
  if (week.length < 3) return;
  const lines = week.map((p, i) => `${i + 1}. ${p.meaning} → ?`).join('\n');
  await push('Sunday Tamil quiz', `Say these in Tamil:\n${lines}\n\nAnswers on your hub (/tamil).`, { tags: 'thinking' });
}

export default {
  start() {
    daily(8, 0, async () => {
      if (istNow().getUTCDay() === 0) return sundayQuiz();
      if (!data.phrases.some((p) => p.date === istDate())) await newPhrase();
    });
  },
  routes: {
    'GET /api/tamil': () => ({ theme: weekTheme(), today: data.phrases.find((p) => p.date === istDate()) || null,
      phrases: [...data.phrases].reverse().slice(0, 100) }),
    'POST /api/tamil/new': () => newPhrase(),
  },
};
