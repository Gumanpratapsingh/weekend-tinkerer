// Reels: one button -> a complete, copy-paste prompt pack for Google Flow (Veo): a 6-scene, ~48 s story with
// dialogue and sound, where every scene prompt starts with the SAME fixed style + character text, so the
// two characters look the same in every clip and every episode. Nothing is posted anywhere from here.
import { load, save, groq, istDate, log } from '../core.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });
const SCENES = 6, SECONDS = 8;                           // Veo clips are 8 s: 6 x 8 = 48 s

// Fixed text, pasted unchanged into every scene: this is what keeps the series consistent.
const STYLE = 'Vertical 9:16 3D low-poly animated short. Flat-shaded faceted geometry, dark indigo tech-office background with two glowing code monitors, '
  + 'warm key light with soft purple and teal rim light, a desk in front of the characters, slow gentle camera push-in, smooth stable motion. '
  + 'No on-screen text, no subtitles, no logos, no watermark.';
const YOU = 'YOU: a young software developer on the left behind the desk, round dark glasses, short dark hair, indigo hoodie, faceted low-poly skin, expressive eyebrows and mouth.';
const BOT = 'AI: a plain orange low-poly cube robot (burnt-orange #D97757) on the right, floating slightly above the desk, two dark rectangular eyes on a flat orange face, '
  + 'a thin mouth line, small block arms on its sides, no antenna, no legs.';
const VOICES = 'Voices: YOU has a casual, slightly stressed young male voice; AI has a calm, smug, friendly synthetic voice. Same voices in every scene.';
const AMBIENT = 'Ambient sound: soft lo-fi keyboard clicks and a quiet synth hum under the dialogue.';
const CONSISTENCY = 'Keep both characters, outfits, room, camera angle, colours and lighting identical to the other scenes of this series.';

const LOCK = [STYLE, YOU, BOT, VOICES, AMBIENT, CONSISTENCY].join(' ');

const clean = (s, n) => String(s || '').replace(/[\r\n]+/g, ' ').replace(/"/g, "'").trim().slice(0, n);

function assemble(story) {
  return story.scenes.map((s, i) => {
    const speech = s.lines.map((l) => `${l.who} says: "${l.text}"`).join(' Then ');
    const prompt = `${LOCK}\n\nScene ${i + 1} of ${SCENES} (${SECONDS} seconds). ${s.action} ${speech}. Sound effect: ${s.sfx}.`;
    return { n: i + 1, seconds: SECONDS, action: s.action, lines: s.lines, sfx: s.sfx, prompt };
  });
}

async function makeStory(topic, recent) {
  const sys = 'You write short, funny, clean scripts for a vertical video series about a developer (YOU) and their AI coding assistant (AI), '
    + 'a smug, overconfident orange robot. Dry humour, relatable developer pain, never mean, no brand names, no swearing, no politics. '
    + 'The video is exactly 6 scenes of 8 seconds. Arc: 1 setup, 2 first problem, 3 it gets worse, 4 absurd escalation, 5 twist, 6 punchline plus a soft ending. '
    + 'Each scene has 1 or 2 spoken lines, each line at most 12 words, and fits in 8 seconds. Lines alternate naturally between YOU and AI. '
    + 'Return JSON only: {"title":string,"logline":string,"scenes":[{"action":string,"lines":[{"who":"YOU"|"AI","text":string}],"sfx":string}],'
    + '"caption":string,"hashtags":[string]}. "action" is one visual sentence (what we SEE, camera, expressions) with no dialogue. '
    + '"sfx" is one short phrase. "caption" is a punchy Instagram caption under 140 characters. 6 to 8 hashtags.';
  const user = `Topic: ${topic || 'your choice, something fresh and relatable'}.${recent.length ? ` Avoid repeating these recent titles: ${recent.join('; ')}.` : ''}`;
  let story;
  for (let attempt = 0; attempt < 2; attempt++) {
    story = await groq([{ role: 'system', content: sys }, { role: 'user', content: user }], { maxTokens: 1800, json: true, temperature: 0.85 });
    if (Array.isArray(story?.scenes) && story.scenes.length === SCENES) break;
    story = null;
  }
  if (!story) throw fail(502, 'The AI did not return a full 6-scene story. Press the button again.');
  return {
    title: clean(story.title, 80) || 'Untitled',
    logline: clean(story.logline, 200),
    scenes: story.scenes.map((s) => ({
      action: clean(s.action, 300),
      lines: (Array.isArray(s.lines) ? s.lines : []).slice(0, 2).map((l) => ({ who: /^ai$/i.test(l.who) ? 'AI' : 'YOU', text: clean(l.text, 110) })).filter((l) => l.text),
      sfx: clean(s.sfx, 80) || 'soft keyboard click',
    })),
    caption: clean(story.caption, 200),
    hashtags: (Array.isArray(story.hashtags) ? story.hashtags : []).slice(0, 8).map((t) => '#' + String(t).replace(/[^\w]/g, '')).filter((t) => t.length > 1),
  };
}

let data = load('reels.json', { packs: [] });
const persist = () => save('reels.json', data);

export default {
  routes: {
    'GET /api/reels': async () => ({
      packs: data.packs.slice(0, 20).map((p) => ({ id: p.id, title: p.title, date: p.date, topic: p.topic })),
      lock: LOCK, scenes: SCENES, seconds: SECONDS,
    }),

    'GET /api/reels/pack': async ({ query }) => {
      const p = data.packs.find((x) => x.id === query.id);
      if (!p) throw fail(404, 'Not found.');
      return p;
    },

    // The button: topic is optional.
    'POST /api/reels/prompt': async ({ body }) => {
      const topic = clean(body.topic, 200);
      const story = await makeStory(topic, data.packs.slice(0, 8).map((p) => p.title));
      if (story.scenes.some((s) => !s.lines.length)) throw fail(502, 'A scene came back without dialogue. Press the button again.');
      const scenes = assemble(story);
      const pack = {
        id: Date.now().toString(16) + Math.random().toString(16).slice(2, 6),
        date: istDate(), topic, title: story.title, logline: story.logline, scenes,
        caption: story.caption, hashtags: story.hashtags,
        totalSeconds: SCENES * SECONDS,
      };
      data.packs.unshift(pack); data.packs = data.packs.slice(0, 60); persist();
      log(`reels: pack "${pack.title}"`);
      return pack;
    },
  },
};
