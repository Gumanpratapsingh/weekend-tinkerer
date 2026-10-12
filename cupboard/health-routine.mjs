// Sets up a personal "Health & glow" chat in Cupboard with daily and weekly reminders (skin, hair, diet, water,
// workouts, sleep). They are ordinary repeating reminders (Together → Calendar), so each one arrives as a card with
// ✓ Done / In 1 hour and a push. Edit or delete any of them in the calendar.
// Runs on the server: node health-routine.mjs <username> [--reset]   (--reset replaces this chat's reminders)
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';

const NAME = 'Health & glow 🌿';
const DAILY = [
  ['07:00', '🌅 Morning: a glass of water, then face wash → moisturiser → sunscreen (SPF 30+)'],
  ['08:30', '🍳 Breakfast: protein (eggs / paneer / sprouts / curd) + one fruit'],
  ['11:00', '💧 Water check: about 1 litre done by now?'],
  ['13:00', '🍛 Lunch: dal or curd + vegetables, skip fried food. A 10-minute walk after'],
  ['16:30', '🍎 Snack: fruit or a handful of nuts (not biscuits). Water: 2 litres by now'],
  ['18:30', '🚶 Steps check: aim for 8,000–10,000. Short walk if you are behind'],
  ['20:00', '🍲 Dinner: light, before 9 PM. Protein + vegetables, less salt and sugar'],
  ['22:00', '🌙 Night skin care: wash off sunscreen, moisturiser, lip balm, hand cream'],
  ['22:45', '😴 Wind down: screens away, lights off by 11 for 7–8 hours of sleep'],
];
// Workouts at 07:30 (0 = Sunday)
const WEEKLY = [
  [1, '07:30', '🏋️ Workout: chest, shoulders, triceps (push), 40 min'],
  [2, '07:30', '🏋️ Workout: legs + core, 40 min'],
  [3, '07:30', '🏋️ Workout: back + biceps (pull), 40 min'],
  [4, '07:30', '🏃 Workout: cardio 30 min + core 10 min'],
  [5, '07:30', '🏋️ Workout: full body, 40 min'],
  [6, '07:30', '🧘 Yoga / stretching or a long walk, 30–45 min'],
  [0, '09:00', '📸 Weekly check-in: progress photo, weight, how your clothes fit'],
  [0, '10:00', '🧖 Weekly care: gentle face + body scrub, face pack, trim nails, fresh pillowcase'],
  [0, '17:00', '💆 Hair: oil 1–2 hours, then mild shampoo + conditioner'],
  [3, '18:00', '💆 Hair: oil 1–2 hours, then mild shampoo + conditioner'],
];

const who = process.argv[2];
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
  run('DELETE FROM events WHERE conv_id = ? AND repeat IS NOT NULL', conv);
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
console.log(`${DAILY.length} daily + ${WEEKLY.length} weekly reminders in "${NAME}" for ${user.name}`);
