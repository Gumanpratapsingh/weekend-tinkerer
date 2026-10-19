// Life-pet: a creature on the Mission Control wall that lives off real events.
//   ?style=fox|jelly|pixel   creature style (default fox)
//   ?demo=1                  fake data, cycles through every state
//   ?demo=<state>            pin one state: idle eat warm hot worried sleep party levelup recap
//   ?hour=<0-24>             force the time of day (sky colours, night fallback)
(() => {
'use strict';
const { clamp, lerp, ell, backOut } = PU;
const Q = new URLSearchParams(location.search);
const DEMO = Q.get('demo');
const STYLE = PET_STYLES[Q.get('style')] ? Q.get('style') : 'fox';
const ST = PET_STYLES[STYLE];
const POLL_MS = 15000;

// ---------- storage (localStorage can throw or be empty; nothing here may break the page)
const PREFIX = DEMO ? 'petdemo.' : 'pet.';
const store = {
  get(k, d) { try { const v = localStorage.getItem(PREFIX + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(PREFIX + k, JSON.stringify(v)); } catch {} },
};

// ---------- time
let demoHour = Q.has('hour') ? Number(Q.get('hour')) : null;
const hourNow = () => { if (demoHour != null) return demoHour; const d = new Date(); return d.getHours() + d.getMinutes() / 60; };
const dateKey = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const hm = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

// ---------- levels: level L starts at 5*L*(L-1) XP (L2 at 10, L5 at 100, L10 at 450, L20 at 1900)
const levelOf = (xp) => Math.floor((1 + Math.sqrt(1 + (4 * xp) / 5)) / 2);
const xpAt = (L) => 5 * L * (L - 1);
const growOf = (L) => 0.8 + 0.38 * (1 - Math.exp(-(L - 1) / 14));

// ---------- canvas + UI stage
const cv = document.getElementById('c'), ctx = cv.getContext('2d');
const ui = document.getElementById('ui');
const $ = (id) => document.getElementById(id);
let W = 0, H = 0, DPR = 1, uiK = 1, uiX = 0, uiY = 0;
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 1.5);
  W = innerWidth; H = innerHeight;
  cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
  uiK = Math.min(W / 1920, H / 1080); uiX = (W - 1920 * uiK) / 2; uiY = (H - 1080 * uiK) / 2;
  ui.style.transform = `translate(${uiX}px, ${uiY}px) scale(${uiK})`;
}
addEventListener('resize', resize); resize();
const uiToScreen = (x, y) => ({ x: uiX + x * uiK, y: uiY + y * uiK });
$('petname').textContent = ST.name;

// ---------- pet simulation state
const pet = {
  phase: 0, blink: 0, nextBlink: 2, blinkAt: -9,
  gx: 0, gy: 0, tgx: 0, tgy: 0, nextGaze: 1,
  tilt: 0, ttilt: 0, nextTilt: 6, fidgetAt: -9, nextFidget: 4,
  sleep: 0, hot: 0, worry: 0, party: 0, happy: 0, eatOpen: 0,
  partyUntil: -1, awakeUntil: -1, happyUntil: -1, levelFxAt: -99, chompAt: -99,
};
const want = { sleep: 0, hot: 0, worry: 0 };
const fx = { foods: [], drops: [], steam: [], zzz: [], confetti: [], crumbs: [], floaters: [], sparks: [] };
let anchors = { head: { x: 0, y: -260, r: 110 }, mouth: { x: 0, y: -200 } };
let mouthScreen = { x: W * 0.42, y: H * 0.6 };
let NOW = 0;  // seconds, from requestAnimationFrame

// ---------- data
const D = { level: 0, xp: 0, fed: 0, goal: 10, interviews: 0, temp: null, batt: null, plugged: false, lights: null, people: [] };
let prev = DEMO ? { at: 0, people: {} } : store.get('prev', { at: 0, people: {} });
let first = true, bootSeen = null;
const flags = {};   // last known hot / low / sleep, for transition captions

// ---------- captions
const capQ = []; let capBusy = false;
function caption(text) {
  if (!text) return;
  if (capQ.length > 4) capQ.splice(1, capQ.length - 2);
  capQ.push(text); if (!capBusy) nextCaption();
}
function nextCaption() {
  const el = $('caption');
  if (!capQ.length) { capBusy = false; el.classList.remove('on'); return; }
  capBusy = true; el.textContent = capQ.shift(); el.classList.add('on');
  setTimeout(() => { el.classList.remove('on'); setTimeout(nextCaption, 550); }, 4300);
}

// ---------- events
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
function eat(n, by, away) {
  const names = Object.keys(by);
  caption(away ? `While I was away I ate ${plural(n, 'application')} 🍜`
               : `Ate ${plural(n, 'application')}${names.length === 1 && names[0] ? ' from ' + names[0] : ''} 🍜`);
  const from = uiToScreen(1380, 520);
  for (let i = 0; i < Math.min(n, 6); i++) fx.foods.push({ t0: NOW + i * 0.5, from, emoji: i % 3 === 1 ? '✉️' : '🍜', n: 1 });
  pet.awakeUntil = Math.max(pet.awakeUntil, NOW + 7 + Math.min(n, 6) * 0.5);
}
function celebrate(n) {
  caption(n > 1 ? `${n} new interviews! 🎉🎉` : 'New interview! 🎉 Party time');
  pet.partyUntil = NOW + 14; pet.awakeUntil = Math.max(pet.awakeUntil, NOW + 16);
  confettiBurst(); setTimeout(confettiBurst, 4200); setTimeout(confettiBurst, 8600);
}
function levelUp(L) {
  caption(`Level ${L}! I grew a little ✨`);
  pet.levelFxAt = NOW; pet.awakeUntil = Math.max(pet.awakeUntil, NOW + 6);
  fx.floaters.push({ t0: NOW, x: 0, y: 0, follow: 'head', text: `LEVEL ${L}`, big: true });
}

// ---------- ingest one /api/state (+ room) reading
function ingest(st, room) {
  if (st.boot && !DEMO) { if (bootSeen && st.boot !== bootSeen) location.reload(); bootSeen = st.boot; }
  const people = (st.people || []).filter(Boolean);
  let ate = 0; const by = {}; let intv = 0;
  const seen = {};
  for (const p of people) {
    const key = String(p.port || p.name);
    const cur = { applied: p.total?.applied ?? null, today: p.today?.applied ?? 0, interviews: p.total?.interviews ?? 0 };
    const was = prev.people[key];
    if (was) {
      const d = cur.applied != null && was.applied != null ? cur.applied - was.applied : cur.today - was.today;
      if (d > 0 && d < 300) { ate += d; by[p.name || ''] = (by[p.name || ''] || 0) + d; }
      const di = cur.interviews - (was.interviews || 0);
      if (di > 0 && di < 20) intv += di;
    }
    seen[key] = cur;
  }
  const awayFor = Date.now() - (prev.at || 0);
  prev = { at: Date.now(), people: { ...prev.people, ...seen } };
  store.set('prev', prev);

  // aggregates
  D.fed = people.reduce((s, p) => s + (p.today?.applied || 0), 0);
  const total = people.reduce((s, p) => s + (p.total?.applied || 0), 0);
  D.interviews = people.reduce((s, p) => s + (p.total?.interviews || 0), 0);
  D.xp = total + 20 * D.interviews;
  const days = {};
  for (const p of people) for (const d of p.days || []) days[d.d] = (days[d.d] || 0) + (d.n || 0);
  const past = Object.entries(days).filter(([d, n]) => d !== dateKey(Date.now()) && n > 0).slice(-7).map(([, n]) => n);
  D.goal = Math.max(5, past.length ? Math.round(past.reduce((a, b) => a + b, 0) / past.length) : 10);
  D.people = people.map((p) => ({ name: p.name || 'agent', today: p.today?.applied || 0 }));
  const L = levelOf(D.xp);
  if (D.level && L > D.level) levelUp(L);
  D.level = L;

  D.temp = st.laptop?.temp ?? null;
  D.batt = st.phone?.battery ?? null;
  D.plugged = !!st.phone?.plugged && st.phone.plugged !== 'UNPLUGGED';
  D.lights = room?.lights === 'on' || room?.lights === 'off' ? room.lights : null;

  // states
  const hot = D.temp == null ? 0 : D.temp >= 88 ? 1 : D.temp >= 80 ? 0.5 : 0;
  const low = D.batt != null && D.batt <= 20;
  const h = hourNow();
  const asleep = D.lights ? D.lights === 'off' : h >= 23 || h < 6.5;
  want.hot = hot; want.worry = low ? (D.plugged ? 0.6 : 1) : 0; want.sleep = asleep ? 1 : 0;

  const recapShown = maybeRecap(asleep);
  if (!first) {
    if (hot !== flags.hot) caption(hot === 1 ? `Laptop is ${D.temp}°C, way too hot 🔥` : hot ? `Laptop is ${D.temp}°C, getting warm 🥵` : flags.hot ? 'Laptop cooled down 😌' : '');
    if (low && !flags.low) caption(`Phone battery ${D.batt}%, I'm hungry for power 🔋`);
    if (low && D.plugged && !flags.plugged) caption('Charging… thank you ⚡');
    if (asleep !== flags.asleep) caption(asleep ? (D.lights ? 'Lights off. Good night 🌙' : 'Getting late. Good night 🌙') : (D.lights ? 'Lights on! Good morning ☀️' : 'Good morning ☀️'));
  }
  if (ate) { if (!(first && (recapShown || awayFor > 6 * 3600e3))) eat(ate, by, first); }
  if (intv) celebrate(intv);
  Object.assign(flags, { hot, low, asleep, plugged: D.plugged });

  trackNight(room);
  first = false;
  hud();
}

// ---------- overnight recap: a snapshot at 23:00 (kept until the morning), shown at the first awake view after 6 am
function snapNow() {
  return { at: Date.now(), xp: D.xp, level: D.level, interviews: D.interviews,
           people: Object.fromEntries(Object.entries(prev.people).map(([k, v]) => [k, v.applied])) };
}
function trackNight(room) {
  const h = hourNow(), now = Date.now();
  if (!(h >= 23 || h < 12)) return;
  const nk = h >= 23 ? dateKey(now) : dateKey(now - 864e5);
  let n = store.get('night', null);
  if (!n || n.key !== nk) { if (h < 23) return; n = { key: nk, snap: snapNow(), maxTemp: null, minBatt: null, offAt: null, onAt: null, names: {} }; }
  if (h >= 23 || h < 6) {
    if (D.temp != null) n.maxTemp = Math.max(n.maxTemp ?? 0, D.temp);
    if (D.batt != null) n.minBatt = Math.min(n.minBatt ?? 100, D.batt);
  }
  if (D.lights === 'off' && !n.offAt) n.offAt = room?.since?.lights || now;
  if (D.lights === 'on' && n.offAt && !n.onAt && h >= 5) n.onAt = room?.since?.lights || now;
  for (const p of D.people) n.names[p.name] = 1;
  store.set('night', n);
}
function maybeRecap(asleep) {
  const h = hourNow(), now = Date.now(), today = dateKey(now);
  if (DEMO || asleep || h < 6 || h >= 18 || store.get('recapShown', '') === today) return false;
  const n = store.get('night', null);
  let base, label, night = null;
  if (!n || n.key !== dateKey(now - 864e5)) return false;   // the page wasn't open at 11 pm last night
  base = n.snap; night = n; label = `${hm(n.snap.at)} → ${hm(now)}`;
  const by = [];
  let sent = 0;
  for (const [k, v] of Object.entries(prev.people)) {
    const was = base.people[k]; if (was == null || v.applied == null) continue;
    const d = Math.max(0, v.applied - was); sent += d; by.push([k, d]);
  }
  store.set('recapShown', today);
  showRecap({ label, sent, interviews: Math.max(0, D.interviews - base.interviews), levelFrom: base.level, levelTo: D.level,
              maxTemp: night?.maxTemp, minBatt: night?.minBatt, offAt: night?.offAt, onAt: night?.onAt, by: namesFor(by) });
  return true;
}
const namesFor = (by) => by.map(([k, d]) => { const p = lastPeople.find((x) => String(x.port || x.name) === k); return [p?.name || 'agent', d]; });
let lastPeople = [];

function showRecap(r) {
  const el = $('recap');
  const dur = (a, b) => { const m = Math.round((b - a) / 60000); return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`; };
  const rows = [
    [r.sent, `application${r.sent === 1 ? '' : 's'} sent 🍜`],
    [r.interviews, `new interview${r.interviews === 1 ? '' : 's'} 🎉`],
    [r.levelTo > r.levelFrom ? `Lv ${r.levelFrom} → ${r.levelTo}` : `Lv ${r.levelTo}`, r.levelTo > r.levelFrom ? 'grew overnight ✨' : 'level'],
  ];
  if (r.maxTemp != null) rows.push([`${r.maxTemp}°C`, `hottest laptop ${r.maxTemp >= 88 ? '🔥' : r.maxTemp >= 80 ? '🥵' : '😌'}`]);
  if (r.minBatt != null) rows.push([`${r.minBatt}%`, 'lowest phone battery 🔋']);
  if (r.offAt && r.onAt && r.onAt > r.offAt) rows.push([dur(r.offAt, r.onAt), `lights off ${hm(r.offAt)}–${hm(r.onAt)} 😴`]);
  el.innerHTML = `<h1>☀️ Good morning!</h1><div class="when">While you slept · ${r.label}</div>
    <div class="rows">${rows.slice(0, 6).map(([b, s]) => `<div><b>${b}</b><span>${s}</span></div>`).join('')}</div>
    ${r.by.length ? `<div class="who">${r.by.map(([n, d]) => `${esc(n)} <b>${d}</b>`).join(' · ')}</div>` : ''}
    <div class="bye"><i></i></div>`;
  el.classList.add('on');
  const bar = el.querySelector('.bye i'); const ms = DEMO ? 9e9 : 45000;
  bar.animate([{ width: '100%' }, { width: '0%' }], { duration: Math.min(ms, 45000), fill: 'forwards' });
  const hide = () => el.classList.remove('on');
  el.onclick = hide; if (ms < 1e9) setTimeout(hide, ms);
  pet.happyUntil = NOW + 6;
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- HUD
function hud() {
  $('lvl').textContent = `Lv ${D.level || 1}`;
  const L = D.level || 1, a = xpAt(L), b = xpAt(L + 1);
  $('xpbar').style.width = `${clamp((D.xp - a) / (b - a)) * 100}%`;
  $('xpt').textContent = `${D.xp - a} / ${b - a} XP`;
  $('bellybar').style.width = `${clamp(D.fed / D.goal) * 100}%`;
  $('bellyt').textContent = `${D.fed} / ${D.goal} today`;
  $('fed').textContent = D.fed;
  $('intv').textContent = D.interviews;
  const t = $('ltemp'); t.textContent = D.temp == null ? '–' : `${D.temp}°`; t.className = D.temp >= 88 ? 'bad' : D.temp >= 80 ? 'warn' : '';
  const bt = $('batt'); bt.textContent = D.batt == null ? '–' : `${D.batt}%${D.plugged ? '⚡' : ''}`; bt.className = D.batt != null && D.batt <= 20 ? 'bad' : '';
  $('people').innerHTML = D.people.map((p) => `<div><span>${esc(p.name)}</span><b>${p.today} today</b></div>`).join('');
}
function moodText() {
  if (pet.party > 0.5) return '🥳 Celebrating!';
  if (NOW - pet.levelFxAt < 3) return '✨ Leveling up';
  if (fx.foods.length || NOW - pet.chompAt < 1.5) return '😋 Munching';
  if (pet.sleep > 0.5) return D.lights === 'off' ? '😴 Asleep (lights off)' : '😴 Asleep';
  if (want.hot === 1) return '🥵 Overheating';
  if (want.hot) return '😓 A bit warm';
  if (want.worry) return D.plugged ? '😟 Low power, charging' : '😟 Low on power';
  if (D.fed >= D.goal) return '😊 Full and happy';
  if (D.fed === 0 && hourNow() >= 12) return '🥺 Peckish';
  return '🙂 Content';
}
setInterval(() => {
  const d = new Date();
  $('clock').firstChild.textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  $('clock').lastChild.textContent = d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
}, 500);
let moodAt = -1;

// ---------- effects
const COLORS = ['#ff4f8b', '#ffd84d', '#7cf0c5', '#8fb4ff', '#ff9f43', '#c58bff', '#ffffff'];
function confettiBurst() {
  const k = H / 1080;
  for (let i = 0; i < 90; i++) {
    const left = i % 2 === 0;
    fx.confetti.push({ x: left ? -10 : W + 10, y: H * 0.9, vx: (left ? 1 : -1) * (300 + Math.random() * 700) * k, vy: -(900 + Math.random() * 700) * k,
      r: Math.random() * 6, vr: (Math.random() - 0.5) * 14, c: COLORS[i % COLORS.length], w: (10 + Math.random() * 10) * k, h: (6 + Math.random() * 6) * k, life: 0, f: Math.random() * 6 });
  }
  for (let i = 0; i < 80; i++)
    fx.confetti.push({ x: Math.random() * W, y: -20 - Math.random() * H * 0.3, vx: (Math.random() - 0.5) * 120 * k, vy: 100 * k,
      r: Math.random() * 6, vr: (Math.random() - 0.5) * 10, c: COLORS[i % COLORS.length], w: (10 + Math.random() * 10) * k, h: (6 + Math.random() * 6) * k, life: 0, f: Math.random() * 6 });
}

function update(dt, dtE) {   // dtE: real elapsed time (not clamped), so moods still settle when frames are throttled
  const t = NOW;
  const ease = (cur, tgt, rate) => cur + (tgt - cur) * (1 - Math.exp(-dtE * rate));
  const sleepTarget = want.sleep && t > pet.awakeUntil ? 1 : 0;
  pet.sleep = ease(pet.sleep, sleepTarget, 1.2);
  pet.hot = ease(pet.hot, want.hot, 2);
  pet.worry = ease(pet.worry, want.worry * (1 - sleepTarget), 2);
  pet.party = ease(pet.party, t < pet.partyUntil ? 1 : 0, 3);
  pet.happy = ease(pet.happy, t < pet.happyUntil || t < pet.partyUntil ? 1 : 0, 4);

  // breathing: slow when asleep, panting when hot
  const period = pet.sleep > 0.5 ? 5 : pet.hot > 0.75 ? 0.55 : pet.hot > 0.3 ? 1.5 : 3.4;
  pet.phase += (dtE * Math.PI * 2) / period;

  // blink
  if (t > pet.nextBlink) { pet.blinkAt = t; pet.nextBlink = t + 2.2 + Math.random() * 4 + (Math.random() < 0.2 ? -1.9 : 0); }
  const bt = (t - pet.blinkAt) / 0.16; pet.blink = bt >= 0 && bt <= 1 ? Math.sin(bt * Math.PI) : 0;

  // gaze: follow flying food, else wander
  const food = fx.foods.find((f) => t >= f.t0);
  if (food && food.pos) { pet.tgx = clamp((food.pos.x - mouthScreen.x) / (W * 0.25), -1, 1); pet.tgy = clamp((food.pos.y - mouthScreen.y) / (H * 0.25), -1, 1); }
  else if (t > pet.nextGaze) {
    pet.nextGaze = t + 1.2 + Math.random() * 3.5;
    const r = Math.random(); pet.tgx = r < 0.35 ? 0 : (Math.random() - 0.5) * 1.8; pet.tgy = r < 0.35 ? 0 : (Math.random() - 0.6) * 1.2;
  }
  pet.gx = ease(pet.gx, pet.tgx, 9); pet.gy = ease(pet.gy, pet.tgy, 9);
  if (t > pet.nextTilt) { pet.nextTilt = t + 5 + Math.random() * 8; pet.ttilt = Math.random() < 0.5 ? 0 : (Math.random() - 0.5) * 2; }
  pet.tilt = ease(pet.tilt, pet.ttilt, 2.5);
  if (t > pet.nextFidget) { pet.fidgetAt = t; pet.nextFidget = t + 3 + Math.random() * 6; }

  // mouth: open as food arrives, chomp after
  let open = 0;
  for (const f of fx.foods) { const p = (t - f.t0) / 1.0; if (p > 0.6 && p < 1) open = Math.max(open, (p - 0.6) / 0.4); }
  const c = t - pet.chompAt; if (c >= 0 && c < 1) open = Math.max(open, Math.abs(Math.sin(c * Math.PI * 3)) * (1 - c));
  pet.eatOpen = open;

  // spawners
  const A = anchors;
  if (pet.hot > 0.3 && pet.sleep < 0.5 && Math.random() < dt * (pet.hot > 0.8 ? 2.6 : 0.9)) {
    const a = -Math.PI * (0.15 + Math.random() * 0.7);
    fx.drops.push({ x: A.head.x + Math.cos(a) * A.head.r * 0.95, y: A.head.y + Math.sin(a) * A.head.r * 0.8, vy: 0, life: 0 });
  }
  if (pet.hot > 0.8 && Math.random() < dt * 2.2) fx.steam.push({ x: A.head.x + (Math.random() - 0.5) * A.head.r, y: A.head.y - A.head.r * 0.8, life: 0 });
  if (pet.sleep > 0.6 && Math.random() < dt * 0.7) fx.zzz.push({ x: A.head.x + A.head.r * 0.55, y: A.head.y - A.head.r * 0.65, life: 0, s: 0.6 + Math.random() * 0.5 });
  if ((pet.happy > 0.5 || pet.party > 0.5) && Math.random() < dt * 4) {
    const a = Math.random() * Math.PI * 2;
    fx.sparks.push({ x: A.head.x + Math.cos(a) * A.head.r * 1.6, y: A.head.y + Math.sin(a) * A.head.r * 1.3, life: 0 });
  }
}

function step(arr, dt, max, fn) { for (let i = arr.length - 1; i >= 0; i--) { const p = arr[i]; p.life += dt; if (p.life > max || fn(p) === false) arr.splice(i, 1); } }

// effects inside the creature's coordinate space (units = 1080p pixels, origin at the creature's feet)
function drawLocalFx(dt) {
  const px = ST.pixel;
  step(fx.drops, dt, 2, (d) => {
    if (d.life > 0.4) { d.vy += 900 * dt; d.y += d.vy * dt; }
    const s = Math.min(1, d.life / 0.4), a = 1 - Math.max(0, d.life - 1.3) / 0.7;
    ctx.globalAlpha = a;
    if (px) { ctx.fillStyle = '#9fe3ff'; const q = 8; ctx.fillRect(Math.round(d.x / q) * q, Math.round(d.y / q) * q, q, q * 2 * s); ctx.fillStyle = '#fff'; ctx.fillRect(Math.round(d.x / q) * q, Math.round(d.y / q) * q, q / 2, q / 2); }
    else {
      const r = 11 * s;
      ctx.fillStyle = '#9fe3ff'; ctx.beginPath(); ctx.moveTo(d.x, d.y - r * 1.8);
      ctx.bezierCurveTo(d.x + r, d.y - r * 0.4, d.x + r, d.y + r, d.x, d.y + r);
      ctx.bezierCurveTo(d.x - r, d.y + r, d.x - r, d.y - r * 0.4, d.x, d.y - r * 1.8); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.8)'; ell(ctx, d.x - r * 0.35, d.y - r * 0.1, r * 0.22, r * 0.35); ctx.fill();
    }
    ctx.globalAlpha = 1;
  });
  step(fx.steam, dt, 2.2, (p) => {
    const r = 14 + p.life * 26; ctx.fillStyle = `rgba(255,255,255,${0.32 * (1 - p.life / 2.2)})`;
    ell(ctx, p.x + Math.sin(p.life * 3) * 14, p.y - p.life * 70, r, r * 0.8); ctx.fill();
  });
  step(fx.zzz, dt, 4, (z) => {
    const a = Math.min(1, z.life / 0.6) * (1 - Math.max(0, z.life - 3) / 1);
    ctx.save(); ctx.translate(z.x + z.life * 34 + Math.sin(z.life * 2) * 10, z.y - z.life * 55); ctx.rotate(-0.2 + Math.sin(z.life * 1.5) * 0.15);
    ctx.font = `800 ${Math.round((34 + z.life * 16) * z.s)}px ${px ? 'monospace' : 'ui-rounded, system-ui, sans-serif'}`;
    ctx.fillStyle = `rgba(214,222,255,${a})`; ctx.strokeStyle = `rgba(40,40,90,${a * 0.6})`; ctx.lineWidth = 5;
    ctx.strokeText('Z', 0, 0); ctx.fillText('Z', 0, 0); ctx.restore();
  });
  step(fx.sparks, dt, 0.9, (s) => {
    const k = Math.sin((s.life / 0.9) * Math.PI) * 12; ctx.fillStyle = 'rgba(255,240,170,.95)';
    if (px) { ctx.fillRect(s.x - 4, s.y - 12, 8, 24); ctx.fillRect(s.x - 12, s.y - 4, 24, 8); return; }
    ctx.beginPath(); ctx.moveTo(s.x, s.y - k); ctx.quadraticCurveTo(s.x, s.y, s.x + k, s.y); ctx.quadraticCurveTo(s.x, s.y, s.x, s.y + k);
    ctx.quadraticCurveTo(s.x, s.y, s.x - k, s.y); ctx.quadraticCurveTo(s.x, s.y, s.x, s.y - k); ctx.fill();
  });
  // worried / hungry-for-power thought bubble
  if (pet.worry > 0.05) {
    const A = anchors, a = pet.worry, bx = A.head.x + A.head.r * 1.45, by = A.head.y - A.head.r * 1.35 + Math.sin(NOW * 1.5) * 6;
    ctx.globalAlpha = a; ctx.fillStyle = 'rgba(255,255,255,.93)';
    const dots = [[A.head.x + A.head.r * 0.8, A.head.y - A.head.r * 0.75, 9], [A.head.x + A.head.r * 1.05, A.head.y - A.head.r * 0.98, 14]];
    for (const [x, y, r] of dots) { if (px) ctx.fillRect(x - r, y - r, r * 2, r * 2); else { ell(ctx, x, y, r, r); ctx.fill(); } }
    if (px) ctx.fillRect(bx - 90, by - 55, 180, 110);
    else { for (const [x, y, r] of [[-50, 5, 50], [0, -18, 58], [50, 2, 50], [0, 25, 48]]) { ell(ctx, bx + x, by + y, r, r * 0.85); ctx.fill(); } }
    // battery icon
    ctx.lineWidth = 7; ctx.strokeStyle = '#2b2f45'; ctx.fillStyle = '#2b2f45';
    ctx.strokeRect(bx - 48, by - 20, 84, 42); ctx.fillRect(bx + 38, by - 8, 10, 18);
    const lvl = clamp((D.batt ?? 15) / 100, 0.04, 1);
    ctx.fillStyle = Math.sin(NOW * 6) > 0 ? '#ff4d6d' : '#ff9aa9'; ctx.fillRect(bx - 42, by - 14, Math.max(8, 72 * lvl), 30);
    ctx.font = '700 30px system-ui'; ctx.fillStyle = '#2b2f45'; ctx.textAlign = 'center'; ctx.fillText(D.plugged ? '⚡' : '?', bx + 70, by + 10); ctx.textAlign = 'start';
    ctx.globalAlpha = 1;
  }
}

function drawScreenFx(dt) {
  const k = H / 1080;
  // flying food
  for (let i = fx.foods.length - 1; i >= 0; i--) {
    const f = fx.foods[i], p = (NOW - f.t0) / 1.0; if (p < 0) continue;
    if (p >= 1) {
      fx.foods.splice(i, 1); pet.chompAt = NOW; pet.happyUntil = NOW + 2.2;
      for (let j = 0; j < 10; j++) fx.crumbs.push({ x: mouthScreen.x, y: mouthScreen.y, vx: (Math.random() - 0.5) * 380 * k, vy: (-Math.random() * 300 - 80) * k, life: 0 });
      fx.floaters.push({ t0: NOW, x: mouthScreen.x + 60 * k, y: mouthScreen.y - 40 * k, text: '+1 XP' });
      continue;
    }
    const e = p * p * (3 - 2 * p), to = mouthScreen, cx = (f.from.x + to.x) / 2, cy = Math.min(f.from.y, to.y) - 280 * k;
    const x = (1 - e) ** 2 * f.from.x + 2 * (1 - e) * e * cx + e * e * to.x, y = (1 - e) ** 2 * f.from.y + 2 * (1 - e) * e * cy + e * e * to.y;
    f.pos = { x, y };
    ctx.save(); ctx.translate(x, y); ctx.rotate(Math.sin(p * 9) * 0.3);
    ctx.font = `${Math.round((88 - p * 34) * k)}px system-ui, "Noto Color Emoji", sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(f.emoji, 0, 0); ctx.restore();
  }
  step(fx.crumbs, dt, 0.9, (c) => { c.vy += 1200 * k * dt; c.x += c.vx * dt; c.y += c.vy * dt; ctx.fillStyle = `rgba(255,214,140,${1 - c.life / 0.9})`; ctx.fillRect(c.x, c.y, 7 * k, 7 * k); });
  step(fx.confetti, dt, 7, (c) => {
    c.vy += 700 * k * dt; c.vx *= 1 - dt * 0.9; c.vy = Math.min(c.vy, 260 * k); c.x += (c.vx + Math.sin(c.life * 3 + c.f) * 60 * k) * dt; c.y += c.vy * dt; c.r += c.vr * dt;
    if (c.y > H + 40) return false;
    ctx.save(); ctx.translate(c.x, c.y); ctx.rotate(c.r); ctx.scale(1, Math.cos(c.life * 6 + c.f));
    ctx.fillStyle = c.c; ctx.globalAlpha = Math.min(1, (7 - c.life) / 1); ctx.fillRect(-c.w / 2, -c.h / 2, c.w, c.h); ctx.restore();
  });
  for (let i = fx.floaters.length - 1; i >= 0; i--) {
    const f = fx.floaters[i], a = NOW - f.t0, dur = f.big ? 2.8 : 1.4;
    if (a > dur) { fx.floaters.splice(i, 1); continue; }
    const x = f.follow ? headScreen.x : f.x, y = (f.follow ? headScreen.y - headScreen.r * 1.7 : f.y) - a * (f.big ? 30 : 70) * k;
    const s = f.big ? backOut(Math.min(1, a / 0.5)) : 1;
    ctx.save(); ctx.translate(x, y); ctx.scale(s, s); ctx.globalAlpha = Math.min(1, (dur - a) / 0.5);
    ctx.font = `${f.big ? 900 : 800} ${Math.round((f.big ? 96 : 40) * k)}px ${ST.pixel ? 'monospace' : 'system-ui, sans-serif'}`; ctx.textAlign = 'center';
    ctx.lineWidth = (f.big ? 10 : 6) * k; ctx.strokeStyle = 'rgba(60,30,0,.55)'; ctx.strokeText(f.text, 0, 0);
    ctx.fillStyle = f.big ? '#ffd166' : '#fff3c4'; ctx.fillText(f.text, 0, 0); ctx.restore();
  }
}
let headScreen = { x: 0, y: 0, r: 100 };

// ---------- frame
let last = 0;
function frame(ms) {
  requestAnimationFrame(frame);
  const tsec = ms / 1000, raw = last ? tsec - last : 0.016, dt = Math.min(0.05, raw); last = tsec; NOW = tsec;
  update(dt, Math.min(2, raw));
  if (NOW - moodAt > 0.5) { moodAt = NOW; const m = moodText(); if ($('mood').textContent !== m) $('mood').textContent = m; }
  const k = H / 1080, h = hourNow();
  const L = D.level || 1;
  const lf = NOW - pet.levelFxAt;
  const env = {
    t: NOW, dt, w: W, h: H, k, hour: h, night: PU.night(h), dusk: PU.dusk(h), cx: W * 0.42, gy: H * ST.ground,
    sleep: pet.sleep, hot: pet.hot, worry: pet.worry, party: pet.party, happy: pet.happy, eatOpen: pet.eatOpen,
    blink: pet.blink, breathe: Math.sin(pet.phase), lookX: pet.gx, lookY: pet.gy, tilt: pet.tilt, fidget: NOW - pet.fidgetAt,
    level: L, grow: growOf(L) * (lf < 0.6 ? 1 + 0.12 * Math.sin((lf / 0.6) * Math.PI) : 1),
  };
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ST.background(ctx, env);
  if (pet.sleep > 0.01) { ctx.fillStyle = `rgba(3,5,22,${0.42 * pet.sleep})`; ctx.fillRect(0, 0, W, H); }
  if (pet.hot > 0.05) {
    const g = ctx.createLinearGradient(0, H, 0, H * 0.35); g.addColorStop(0, `rgba(255,90,40,${0.28 * pet.hot})`); g.addColorStop(1, 'rgba(255,90,40,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }

  // creature
  const dance = pet.party, jump = lf < 0.9 ? Math.sin((lf / 0.9) * Math.PI) * 110 : 0;
  const jitter = pet.worry > 0.3 && (NOW % 3.2) < 0.45 ? Math.sin(NOW * 70) * 3 * pet.worry : 0;
  ctx.save();
  ctx.translate(env.cx + jitter * k, env.gy - (Math.abs(Math.sin(NOW * 6.5)) * 42 * dance + jump) * k);
  ctx.scale(k, k); ctx.rotate(Math.sin(NOW * 6.5) * 0.09 * dance);
  if (lf < 2.6) {   // level-up burst behind the creature
    const a = 1 - lf / 2.6, A = anchors.head;
    ctx.save(); ctx.translate(A.x, A.y); ctx.rotate(lf * 0.8); ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 14; i++) { ctx.rotate((Math.PI * 2) / 14); ctx.fillStyle = `rgba(255,210,100,${0.22 * a})`; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-40, -520); ctx.lineTo(40, -520); ctx.fill(); }
    ctx.strokeStyle = `rgba(255,230,150,${a})`; ctx.lineWidth = 10; ell(ctx, 0, 0, 80 + lf * 260, 80 + lf * 260); ctx.stroke();
    ctx.restore();
  }
  anchors = ST.creature(ctx, env) || anchors;
  drawLocalFx(dt);
  const m = ctx.getTransform();
  const mp = m.transformPoint(new DOMPoint(anchors.mouth.x, anchors.mouth.y)); mouthScreen = { x: mp.x / DPR, y: mp.y / DPR };
  const hp = m.transformPoint(new DOMPoint(anchors.head.x, anchors.head.y)); headScreen = { x: hp.x / DPR, y: hp.y / DPR, r: anchors.head.r * k };
  ctx.restore();
  drawScreenFx(dt);
}
requestAnimationFrame(frame);

// ---------- polling
async function poll() {
  let st = null, room = null;
  if (DEMO) ({ st, room } = demo.tick());
  else {
    [st, room] = await Promise.all([
      fetch('/api/state', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch('room.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
  }
  if (st) { lastPeople = (st.people || []).filter(Boolean); ingest(st, room); }
}

// ---------- demo: fake data that walks through every state
const demo = (() => {
  if (!DEMO) return null;
  $('badge').textContent = `demo · ${DEMO === '1' ? 'all states' : DEMO} · style ${STYLE}`;
  const SCENES = ['idle', 'eat', 'warm', 'hot', 'worried', 'sleep', 'party', 'levelup', 'recap'];
  const fake = { a: 262, b: 170, ta: 8, tb: 14, ia: 3, ib: 1 };
  const t0 = Date.now(); let scene = null, sceneAt = 0, lastFeed = 0, lastParty = 0, leveled = false;
  return {
    tick() {
      const el = (Date.now() - t0) / 1000;
      const want = DEMO === '1' ? SCENES[Math.floor(el / 9) % SCENES.length] : SCENES.includes(DEMO) ? DEMO : 'idle';
      if (want !== scene) { scene = want; sceneAt = el; lastFeed = el; lastParty = -99; leveled = false; }
      const into = el - sceneAt;   // effects start 1 s into a scene so the first reading is the baseline
      demoHour = Q.has('hour') ? Number(Q.get('hour')) : scene === 'sleep' ? 1.5 : scene === 'recap' ? 7.2 : 14;
      if (scene === 'eat' && el - lastFeed >= 2.5) { lastFeed = el; if (Math.random() < 0.5) { fake.a++; fake.ta++; } else { fake.b += 2; fake.tb += 2; } }
      if (scene === 'party' && into >= 1 && el - lastParty >= 15) { lastParty = el; fake.ia++; }
      if (scene === 'levelup' && into >= 1 && !leveled) { leveled = true; const xp = fake.a + fake.b + 20 * (fake.ia + fake.ib); fake.a += xpAt(levelOf(xp) + 1) - xp; fake.ta += 3; }
      if (scene === 'recap' && into >= 1 && !$('recap').classList.contains('on'))
        showRecap({ label: '11:00 pm → 7:12 am', sent: 17, interviews: 1, levelFrom: D.level - 1, levelTo: D.level, maxTemp: 86, minBatt: 41,
                    offAt: Date.now() - 7.2 * 3600e3, onAt: Date.now() - 0.3 * 3600e3, by: [['Agent A', 9], ['Agent B', 8]] });
      if (scene !== 'recap') $('recap').classList.remove('on');
      return {
        st: {
          people: [
            { port: 1, name: 'Agent A', today: { found: 72, matched: 21, applied: fake.ta }, total: { applied: fake.a, interviews: fake.ia }, days: [{ d: '2026-10-15', n: 24 }, { d: '2026-10-16', n: 15 }, { d: '2026-10-17', n: 13 }] },
            { port: 2, name: 'Agent B', today: { found: 226, matched: 53, applied: fake.tb }, total: { applied: fake.b, interviews: fake.ib }, days: [{ d: '2026-10-15', n: 29 }, { d: '2026-10-16', n: 15 }, { d: '2026-10-17', n: 8 }] },
          ],
          laptop: { temp: scene === 'hot' ? 91 : scene === 'warm' ? 83 : 61, cpu: 12, load: 0.4, mem: 20 },
          phone: { battery: scene === 'worried' ? 14 : 76, plugged: 'UNPLUGGED', temp: 33 },
        },
        room: { lights: scene === 'sleep' ? 'off' : 'on', since: { lights: Date.now() - 3600e3 } },
      };
    },
  };
})();

poll(); setInterval(poll, DEMO ? 1000 : POLL_MS);

// hide the cursor when the mouse is still
let still; addEventListener('mousemove', () => { document.body.classList.remove('still'); clearTimeout(still); still = setTimeout(() => document.body.classList.add('still'), 3000); });
})();
