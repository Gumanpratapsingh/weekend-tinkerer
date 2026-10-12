// Sets up a personal "Health & glow" chat in Cupboard with daily and weekly reminders (skin, hair, diet, water,
// workouts, sleep). They are ordinary repeating reminders (Together → Calendar), so each one arrives as a card with
// ✓ Done / In 1 hour and a push. Edit or delete any of them in the calendar.
// Runs on the server: node health-routine.mjs <username> [--bride] [--wedding=YYYY-MM-DD] [--reset]
//   --bride: the bride's workouts, hair care and countdown (trials, mehendi, waxing) instead of the groom's.
//   --wedding adds a dated countdown (facials, haircut, fittings, wedding week); --reset replaces ALL of this chat's reminders.
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';

const NAME = 'Health & glow 🌿';
const DAILY = [
  ['07:00', '🌅 Morning: a glass of water, then face wash → moisturiser → sunscreen (SPF 30+)'],
  ['08:30', '🍳 Breakfast: protein (eggs / paneer / sprouts / curd) + one fruit'],
  ['11:00', '💧 Water check: about 1 litre done by now?'],
  ['13:00', '🍛 Lunch: dal or curd + vegetables, skip fried food. A 10-minute walk after'],
  ['14:00', '🧴 Hands: hand cream after washing. Gloves for dishes and cleaning. No biting or picking nails'],
  ['16:30', '🍎 Snack: fruit or a handful of nuts (not biscuits). Water: 2 litres by now'],
  ['18:30', '🚶 Steps check: aim for 8,000–10,000. Short walk if you are behind'],
  ['20:00', '🍲 Dinner: light, before 9 PM. Protein + vegetables, less salt and sugar'],
  ['22:00', '🌙 Night skin care: wash off sunscreen, moisturiser, lip balm'],
  ['22:15', '💅 Nails: rub cuticle oil (or coconut / almond oil) into each nail for a minute, then hand cream'],
  ['22:45', '😴 Wind down: screens away, lights off by 11 for 7–8 hours of sleep'],
];
// One-time check-points, in days from setup: compare with the first photos.
const ONCE = [
  [0, '📸 Day 0: send your first photos here now (nails, face, hair, body) so you can compare later'],
  [30, '📸 Day 30: nail photos today. Compare with day 0: cuticles, shape, shine, ridges. Still peeling or discoloured? See a dermatologist'],
  [60, '📸 Day 60: nail photos today. Compare with day 0 and day 30'],
];
// Countdown to the wedding (--wedding=YYYY-MM-DD): [days before, time, what]. Ones already past are skipped.
const WEDDING_GROOM = [
  [60, '09:30', 'Book a dermatologist visit this week (skin + nails) and a health check-up: vitamin D, B12, iron, thyroid'],
  [58, '09:30', 'Book a dental check-up and cleaning'],
  [54, '10:00', 'Decide your wedding hair and beard style; save photos for the barber'],
  [48, '10:00', 'Clean-up / facial #1 today (next ones at D-27 and D-10)'],
  [41, '10:00', 'Outfits: start fittings. Buy the wedding shoes and wear them at home to break them in'],
  [34, '10:00', 'Haircut: trim and shape for the big day'],
  [30, '09:30', 'From today: no new skin or hair products (only what already suits you)'],
  [27, '10:00', 'Clean-up / facial #2 today'],
  [20, '10:00', 'Final outfit fitting with shoes and accessories; get alterations done'],
  [10, '10:00', 'Final facial today (never in the last 3 days)'],
  [7, '10:00', 'Haircut today (it settles in a week). Manicure + pedicure. Teeth cleaning if not done yet'],
  [6, '10:00', 'Pack the emergency kit: safety pins, painkillers, antacids, plasters, blotting paper, deodorant, perfume, charger, mints'],
  ...[6, 5, 4, 3, 2].map((d) => [d, '21:00', 'Wedding week: sleep before 11, light home food, lots of water, less salt']),
  [1, '18:00', 'Tomorrow is the day: beard trim or shave, file nails, lay out the outfits, hand jewellery to one trusted person. Sleep early'],
  [0, '07:00', "It's your wedding day 🎉 Proper breakfast, moisturiser + lip balm, keep water and blotting paper close"],
];
// The bride's countdown: trials, mehendi, waxing and threading timing.
const WEDDING_BRIDE = [
  [60, '09:30', 'Book a dermatologist visit this week (skin + nails) and a health check-up: vitamin D, B12, iron, thyroid'],
  [58, '09:30', 'Book a dental check-up and cleaning'],
  [55, '10:00', 'Start a hair spa every 2–3 weeks (book the first one this week)'],
  [50, '10:00', 'Makeup artist and mehendi artist: confirm the bookings and dates'],
  [48, '10:00', 'Facial #1 today, ideally with the person doing the final one (next at D-27 and D-10)'],
  [45, '10:00', 'Plan waxing / laser sessions up to the wedding (last waxing at D-7)'],
  [41, '10:00', 'Outfits: start fittings (blouse too). Buy the wedding footwear and wear it at home to break it in'],
  [35, '10:00', 'Hair trim to remove split ends'],
  [30, '09:30', 'From today: no new skin or hair products (only what already suits you)'],
  [27, '10:00', 'Facial #2 today'],
  [25, '10:00', 'Makeup trial + hair trial for each function. Take photos in daylight and decide the looks'],
  [21, '10:00', 'Mehendi test patch on the inner arm (allergy check)'],
  [20, '10:00', 'Final outfit fitting with jewellery and footwear; get alterations done'],
  [10, '10:00', 'Final facial today (never in the last 3 days)'],
  [7, '10:00', 'Last threading and waxing. Teeth cleaning if not done yet'],
  [6, '10:00', 'Pack the emergency kit: safety pins, bobby pins, fashion tape, painkillers, antacids, pads, blotting paper, lip colour, perfume, charger, mints'],
  ...[6, 5, 4, 3].map((d) => [d, '21:00', 'Wedding week: sleep before 11, light home food, lots of water, less salt']),
  [3, '10:00', 'Manicure + pedicure today (before the mehendi)'],
  [2, '10:00', 'Mehendi day: the colour peaks on day 2. Keep it on long; no water on it for a few hours'],
  [1, '18:00', 'Tomorrow is the day: lay out the outfits and jewellery with one trusted person, light dinner, moisturise, sleep early'],
  [0, '07:00', "It's your wedding day 🎉 Proper breakfast, moisturiser + lip balm before makeup, keep water and snacks close"],
];
// Workouts at 07:30 (0 = Sunday)
const WEEKLY_GROOM = [
  [1, '07:30', '🏋️ Workout: chest, shoulders, triceps (push), 40 min'],
  [2, '07:30', '🏋️ Workout: legs + core, 40 min'],
  [3, '07:30', '🏋️ Workout: back + biceps (pull), 40 min'],
  [4, '07:30', '🏃 Workout: cardio 30 min + core 10 min'],
  [5, '07:30', '🏋️ Workout: full body, 40 min'],
  [6, '07:30', '🧘 Yoga / stretching or a long walk, 30–45 min'],
  [0, '09:00', '📸 Progress photos in daylight, sent to this chat: both hands from the top (nails), face front + sides, hair, full body. Note your weight'],
  [0, '10:30', '💅 Nail care: trim straight across, file in one direction, gently push back cuticles after a shower (never cut them). Buff ridges lightly only every 2nd week'],
  [0, '10:00', '🧖 Weekly care: gentle face + body scrub, face pack, trim nails, fresh pillowcase'],
  [0, '17:00', '💆 Hair: oil 1–2 hours, then mild shampoo + conditioner'],
  [3, '18:00', '💆 Hair: oil 1–2 hours, then mild shampoo + conditioner'],
];
const WEEKLY_BRIDE = [
  [1, '07:30', '🏋️ Workout: full-body strength, 40 min'],
  [2, '07:30', '🏃 Workout: cardio 30 min + core 10 min'],
  [3, '07:30', '🏋️ Workout: legs + glutes, 40 min'],
  [4, '07:30', '🧘 Yoga, 40 min (posture and calm)'],
  [5, '07:30', '🏋️ Workout: upper body + core, 40 min'],
  [6, '07:30', '💃 Dance practice / brisk walk, 45 min (sangeet prep counts!)'],
  [0, '09:00', '📸 Progress photos in daylight, sent to this chat: both hands from the top (nails), face front + sides, hair, full body. Note your weight'],
  [0, '10:00', '🧖 Weekly care: gentle face + body scrub, face pack, fresh pillowcase'],
  [0, '10:30', '💅 Nail care: trim and shape, file in one direction, gently push back cuticles after a shower (never cut them). Buff ridges lightly only every 2nd week'],
  [0, '17:00', '💆 Hair: oil 1–2 hours, wash with mild shampoo + conditioner, then a hair mask (curd or aloe) for 15 min'],
  [3, '18:00', '💆 Hair: oil 1–2 hours, then mild shampoo + conditioner'],
];

const who = process.argv[2], bride = process.argv.includes('--bride');
const WEEKLY = bride ? WEEKLY_BRIDE : WEEKLY_GROOM, WEDDING = bride ? WEDDING_BRIDE : WEDDING_GROOM;
if (!who) { console.error('usage: node health-routine.mjs <username> [--reset]'); process.exit(1); }
const db = new DatabaseSync(join(homedir(), 'cupboard', 'data', 'cupboard.db'));
const one = (sql, ...a) => db.prepare(sql).get(...a), run = (sql, ...a) => db.prepare(sql).run(...a);
const user = one("SELECT * FROM users WHERE username = ? AND active = 1 AND role != 'bot'", who);
if (!user) { console.error(`no Cupboard user ${who}`); process.exit(1); }
const bot = one("SELECT id FROM users WHERE role = 'bot'").id;

// The chat: a group with just this person, so it never mixes with the S20 / job agent chat.
let conv = one("SELECT c.id FROM convs c JOIN members m ON m.conv_id = c.id WHERE c.kind = 'group' AND c.name = ? AND m.user_id = ?", NAME, user.id)?.id;
const now = Date.now();
if (!conv) {
  conv = Number(run("INSERT INTO convs(kind, name, created_by, created) VALUES('group', ?, ?, ?)", NAME, user.id, now).lastInsertRowid);
  run('INSERT INTO members(conv_id, user_id) VALUES(?, ?)', conv, user.id);
  run("INSERT INTO messages(conv_id, user_id, kind, text, extra, created) VALUES(?, ?, 'card', ?, ?, ?)", conv, bot,
    'Your daily reminders for skin, hair, food, water, workouts and sleep arrive here. Tap ✓ Done or "In 1 hour" on each.\n' +
    'Change or delete any of them in Together → Calendar. Mute this chat any time from its menu (reminders still come).',
    JSON.stringify({ title: '🌿 Health & glow' }), now);
  console.log(`created chat ${conv}`);
} else if (process.argv.includes('--reset')) {
  run('DELETE FROM events WHERE conv_id = ?', conv);
} else if (one('SELECT 1 FROM events WHERE conv_id = ? AND repeat IS NOT NULL', conv)) {
  console.log('reminders already set (use --reset to replace them)'); process.exit(0);
}

// Next time this clock time comes round in India (optionally on a weekday).
const IST = 5.5 * 3600e3;
function next(hhmm, dow = null) {
  const [h, m] = hhmm.split(':').map(Number), d = new Date(now + IST);
  let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, m) - IST;
  if (dow === null) return t > now ? t : t + 86400e3;
  let add = (dow - d.getUTCDay() + 7) % 7;
  if (add === 0 && t <= now) add = 7;
  return t + add * 86400e3;
}
const add = run.bind(null, "INSERT INTO events(conv_id, title, starts, all_day, remind_at, for_all, kind, repeat, created_by, created, sent) VALUES(?,?,?,0,?,1,'reminder',?,?,?,0)");
for (const [hhmm, title] of DAILY) { const t = next(hhmm); add(conv, title, t, t, 'daily', user.id, now); }
for (const [dow, hhmm, title] of WEEKLY) { const t = next(hhmm, dow); add(conv, title, t, t, 'weekly', user.id, now); }
const wedding = /--wedding=(\d{4})-(\d{2})-(\d{2})/.exec(process.argv.join(' '));
if (wedding) {
  const day0 = Date.UTC(+wedding[1], +wedding[2] - 1, +wedding[3]) - IST;      // midnight, India time
  let n = 0;
  for (const [before, hhmm, title] of WEDDING) {
    const [h, m] = hhmm.split(':').map(Number), t = day0 - before * 86400e3 + (h * 60 + m) * 60e3;
    if (t > now) { add(conv, before ? `💍 D-${before}: ${title}` : `💍 ${title}`, t, t, null, user.id, now); n++; }
  }
  console.log(`${n} wedding countdown reminders up to ${wedding[0].slice(10)}`);
}
for (const [days, title] of ONCE) { const t = days ? next('09:30') + (days - 1) * 86400e3 : now + 60e3; add(conv, title, t, t, null, user.id, now); }
console.log(`${DAILY.length} daily + ${WEEKLY.length} weekly + ${ONCE.length} check-point reminders in "${NAME}" for ${user.name}`);
