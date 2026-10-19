// "Bit", a pixel-art slime in a 240x135 retro world (each pixel = 8 screen pixels at 1080p).
(() => {
const { mixA, css, rng, clamp } = PU;
const BW = 240, BH = 135, GY = 108;
const R = rng(3);
const STARS = Array.from({ length: 70 }, () => ({ x: Math.floor(R() * BW), y: Math.floor(R() * 70), p: R() * 6 }));
const CLOUDS = Array.from({ length: 5 }, () => ({ x: R() * 280, y: 8 + Math.floor(R() * 40), v: 1 + R() * 2, s: R() < 0.5 }));
const TUFTS = Array.from({ length: 34 }, () => ({ x: Math.floor(R() * BW), c: R() }));

const bg = document.createElement('canvas'); bg.width = BW; bg.height = BH;
const b = bg.getContext('2d');
const land = document.createElement('canvas'); land.width = BW; land.height = BH;
const l = land.getContext('2d');
let landN = -1;
const hsl = (h, s, v) => { s /= 100; v /= 100; const k = (n) => (n + h / 30) % 12, a = s * Math.min(v, 1 - v);
  const f = (n) => v - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)); return [f(0), f(8), f(4)].map((x) => Math.round(x * 255)); };

function drawLand(n) {
  l.clearRect(0, 0, BW, BH);
  const far = css(mixA('#7d8fc9', '#1d2346', n)), snow = css(mixA('#f2f6ff', '#6f7aa6', n)), near = css(mixA('#4f9d58', '#142a2f', n));
  for (let x = 0; x < BW; x++) {
    const t = Math.round(GY - (26 + 12 * Math.sin(x * 0.045 + 1) + 7 * Math.sin(x * 0.11)));
    l.fillStyle = far; l.fillRect(x, t, 1, GY - t);
    if (t < GY - 38) { l.fillStyle = snow; l.fillRect(x, t, 1, 2); }
    const t2 = Math.round(GY - (8 + 5 * Math.sin(x * 0.07 + 2) + 2 * Math.sin(x * 0.23)));
    l.fillStyle = near; l.fillRect(x, t2, 1, GY - t2);
  }
  l.fillStyle = css(mixA('#7ad65e', '#2a4a3a', n)); l.fillRect(0, GY, BW, 1);
  l.fillStyle = css(mixA('#4fae47', '#1d3a2e', n)); l.fillRect(0, GY + 1, BW, 2);
  const d1 = css(mixA('#9a6a3e', '#2e2233', n)), d2 = css(mixA('#86592f', '#261c2b', n));
  for (let y = GY + 3; y < BH; y += 3) for (let x = 0; x < BW; x += 3) { l.fillStyle = ((x + y) / 3) % 2 ? d1 : d2; l.fillRect(x, y, 3, 3); }
  landN = n;
}

function background(ctx, e) {
  const n = e.night, t = e.t, d = e.dusk * (1 - n * 0.5);
  const top = mixA(mixA('#4aa8ff', '#070b24', n), '#5a3f8f', d * 0.7), bot = mixA(mixA('#bfe6ff', '#25306a', n), '#ff9a6a', d);
  for (let y = 0; y < GY; y++) { const q = Math.floor((y / GY) * 9) / 9; b.fillStyle = css(mixA(top, bot, q)); b.fillRect(0, y, BW, 1); }
  if (n > 0.05) for (const s of STARS) if (Math.sin(t * 1.4 + s.p) > -0.3) { b.fillStyle = `rgba(255,255,255,${n})`; b.fillRect(s.x, s.y, 1, 1); }
  // sun or moon
  const cx = 150, cy = 22 + Math.round(n * 0);
  const disc = (x0, y0, r, c) => { b.fillStyle = c; for (let y = -r; y <= r; y++) { const w = Math.round(Math.sqrt(r * r - y * y)); b.fillRect(x0 - w, y0 + y, w * 2 + 1, 1); } };
  if (n < 0.5) { disc(cx, cy, 10, 'rgba(255,240,170,.35)'); disc(cx, cy, 7, css(mixA('#fff2a8', '#ffb060', e.dusk))); }
  else { disc(cx, cy, 7, '#eef1ff'); disc(cx + 3, cy - 2, 6, css(mixA(top, bot, cy / GY))); }
  // clouds
  b.fillStyle = css(mixA('#ffffff', '#38406e', n));
  for (const c of CLOUDS) {
    const x = Math.round(((c.x + t * c.v) % 290) - 30), y = c.y;
    b.fillRect(x, y + 2, 16, 3); b.fillRect(x + 3, y, 8, 2); b.fillRect(x + 9, y + 1, 5, 1); if (c.s) { b.fillRect(x + 14, y + 3, 6, 2); }
  }
  if (Math.abs(n - landN) > 0.02) drawLand(n);
  b.drawImage(land, 0, 0);
  // grass tufts swaying in two frames, fireflies at night
  const fr = Math.floor(t * 2) % 2;
  for (const tf of TUFTS) { b.fillStyle = css(mixA(tf.c < 0.5 ? '#9be86e' : '#ffd84d', '#2f5a40', n)); b.fillRect(tf.x + (fr && tf.c < 0.5 ? 1 : 0), GY - 1, 1, 1); if (tf.c < 0.5) b.fillRect(tf.x, GY - 2, 1, 1); }
  if (n > 0.3) for (let i = 0; i < 10; i++) {
    const x = Math.round(20 + ((i * 53 + Math.sin(t * 0.3 + i) * 20) % 200)), y = Math.round(80 + Math.sin(t * 0.5 + i * 2) * 14);
    if (Math.sin(t * 2 + i) > 0) { b.fillStyle = `rgba(255,240,120,${n})`; b.fillRect(x, y, 1, 1); }
  }
  // cover the screen with nearest-neighbour scaling
  const s = Math.max(e.w / BW, e.h / BH);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bg, (e.w - BW * s) / 2, e.h - BH * s, BW * s, BH * s);
}

// ---- the slime sprite, redrawn at 1 px per pixel every frame
const SW = 96, SH = 84, BASE = 78;
const sc = document.createElement('canvas'); sc.width = SW; sc.height = SH;
const s = sc.getContext('2d');

function creature(ctx, e) {
  s.clearRect(0, 0, SW, SH);
  const g = e.grow, br = e.breathe, sl = e.sleep, hot = e.hot, wo = e.worry, pa = e.party, hp = e.happy;
  const half = Math.round(22 * g + br * 1.4), Hh = Math.round(34 * g - br * 2);
  let base = hot <= 0.5 ? mixA('#5ed45f', '#ffc23d', hot * 2) : mixA('#ffc23d', '#ff5a3d', (hot - 0.5) * 2); base = mixA(base, '#86a9df', wo * 0.8); base = mixA(base, '#3f6fa0', sl * 0.55);
  if (pa > 0.02) base = mixA(base, hsl((e.t * 140) % 360, 80, 60), clamp(pa * 2));
  const C = { body: css(base), shade: css(mixA(base, '#0b1020', 0.3)), light: css(mixA(base, '#ffffff', 0.45)), line: css(mixA(base, '#0b1020', 0.8)) };
  const P = (x, y, c) => { s.fillStyle = c; s.fillRect(48 + x, y, 1, 1); };
  const span = (x0, x1, y, c) => { if (x1 < x0) return; s.fillStyle = c; s.fillRect(48 + x0, y, x1 - x0 + 1, 1); };
  const top = BASE - Hh + 1;
  const wr = [];
  for (let r = 0; r < Hh; r++) {
    const v = (r + 0.5) / Hh;
    const f = v < 0.62 ? Math.sqrt(1 - ((0.62 - v) / 0.62) ** 2) : r === Hh - 1 ? 0.9 : r === Hh - 2 ? 0.97 : 1;
    wr.push(Math.max(1, Math.round(half * f)));
  }
  span(-half - 1, half + 1, BASE + 1, 'rgba(0,0,0,.28)'); span(-half + 3, half - 3, BASE + 2, 'rgba(0,0,0,.18)');
  for (let r = 0; r < Hh; r++) {
    const w = wr[r], inner = Math.min(w - 1, r > 0 ? wr[r - 1] : -1, r < Hh - 1 ? wr[r + 1] : -1), y = top + r;
    span(-w, -inner - 1, y, C.line); span(inner + 1, w, y, C.line);
    span(-inner, inner, y, C.body);
    if (inner > 3) span(inner - 2, inner, y, C.shade);
    if (r >= Hh - 3 && inner > 0) span(-inner, inner, y, C.shade);
    if (r > Hh * 0.14 && r < Hh * 0.5 && inner > 4) span(-inner + 1, -inner + 1, y, C.light);
  }
  // hair curl on top, shine
  P(0, top - 1, C.line); P(-1, top - 2, C.line); P(-2, top - 2, C.line); P(-3, top - 1, C.line);
  const hr = top + Math.round(Hh * 0.2), hx = -Math.round(half * 0.5);
  span(hx, hx + 2, hr, C.light); span(hx, hx, hr + 1, C.light); P(hx + 1, hr - 1, '#ffffff');

  // face
  const er = top + Math.round(Hh * 0.52), ex = Math.max(5, Math.round(half * 0.38));
  const lx = Math.round(e.lookX), ly = Math.round(e.lookY * 0.8);
  const closed = Math.max(e.blink, clamp((sl - 0.4) * 2.5)), happyEyes = Math.max(pa, hp) > 0.5 && sl < 0.4;
  const EYE = '#141420';
  for (const sx of [-1, 1]) {
    const cx = sx * ex + lx, cy = er + ly;
    if (happyEyes) { P(cx - 1, er + 1, EYE); P(cx, er, EYE); P(cx + 1, er + 1, EYE); continue; }
    if (closed > 0.85) { P(cx - 1, er + 1, EYE); P(cx, er + 2, EYE); P(cx + 1, er + 1, EYE); continue; }
    if (closed > 0.4) { span(cx - 1, cx + 1, er + 1, EYE); continue; }
    s.fillStyle = EYE; s.fillRect(48 + cx - 1, cy - 1, 2, wo > 0.4 ? 4 : 3); P(cx - 1, cy - 1, '#ffffff');
    if (wo > 0.4) P(cx, cy + 3, '#a8e4ff');
  }
  if (wo > 0.3) for (const sx of [-1, 1]) { P(sx * (ex + 1), er - 3, EYE); P(sx * ex, er - 4, EYE); P(sx * (ex - 1), er - 4, EYE); }
  // blush
  if (hot > 0.2 || pa > 0.3 || hp > 0.3 || sl < 0.3) for (const sx of [-1, 1]) span(sx > 0 ? ex + 2 : -ex - 3, sx > 0 ? ex + 3 : -ex - 2, er + 2, hot > 0.3 ? '#ff4d6d' : '#ff9ab0');
  // mouth
  const mr = er + 4;
  const pant = hot > 0.4 && sl < 0.5 ? (0.5 + 0.5 * Math.abs(Math.sin(e.t * 6))) * hot : 0;
  const open = Math.max(e.eatOpen, pant * 0.8, pa * (0.55 + 0.25 * Math.sin(e.t * 6.5)));
  if (open > 0.15) {
    const h = 1 + Math.round(open * 3);
    s.fillStyle = '#5a1424'; s.fillRect(48 - 2, mr, 5, h);
    if (h >= 2) span(-1, 1, mr + h - 1, '#ff7b9c');
    if (pant > 0.15) { P(0, mr + h, '#ff7b9c'); P(1, mr + h, '#ff7b9c'); P(0, mr + h + 1, '#ff7b9c'); }
  } else if (wo > 0.4) { P(-2, mr + 1, EYE); P(-1, mr, EYE); P(0, mr + 1, EYE); P(1, mr, EYE); P(2, mr + 1, EYE); }
  else { P(-2, mr, EYE); span(-1, 1, mr + 1, EYE); P(2, mr, EYE); }
  // sleeping: snot bubble
  if (sl > 0.6) {
    const rr = 1 + Math.round(2.5 * (0.5 + 0.5 * Math.sin(e.t * 1.3))), bx = ex + 2, by = er + 1 - rr;
    for (let dy = -rr; dy <= rr; dy++) for (let dx = -rr; dx <= rr; dx++) { const d = Math.hypot(dx, dy); if (Math.abs(d - rr) < 0.6) P(bx + dx, by + dy, '#bfe9ff'); }
    if (rr > 1) P(bx - 1, by - 1, '#ffffff');
  }
  // hats
  if (pa > 0.3) for (let i = 0; i < 11; i++) { const w = Math.floor(i / 2), y = top - 13 + i; span(4 - w, 4 + w, y, Math.floor(i / 2) % 2 ? '#ffd84d' : '#ff4f8b'); if (i === 0) { span(3, 5, y - 2, '#fff'); span(3, 5, y - 1, '#fff'); } }
  else if (sl > 0.6) {
    for (let i = 0; i < 9; i++) span(-6 + Math.floor(i * 0.3), 2 + Math.floor(i * 1.1) - Math.floor(i * 0.5), top - 2 - (8 - i), '#5b6cff');
    span(-7, 4, top - 1, '#f4f2ff'); span(5, 6, top - 11, '#f4f2ff'); span(5, 6, top - 10, '#f4f2ff');
  }
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(sc, -48 * 8, -(BASE + 1) * 8, SW * 8, SH * 8);
  return { head: { x: 0, y: -Hh * 0.6 * 8, r: half * 8 }, mouth: { x: 4, y: -(BASE - mr) * 8 } };
}

PET_STYLES.pixel = { name: 'Bit', label: 'Pixel slime', ground: GY / BH, pixel: true, background, creature };
})();
