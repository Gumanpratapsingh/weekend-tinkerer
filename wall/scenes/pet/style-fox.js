// "Kit", a vector fox sitting on a hill. Sky follows the time of day.
(() => {
const { mix, mixA, css, ell, rng, clamp, backOut } = PU;
const R = rng(7);
const STARS = Array.from({ length: 160 }, () => ({ x: R(), y: R() * 0.62, r: 0.6 + R() * 1.6, p: R() * 6 }));
const FLIES = Array.from({ length: 16 }, () => ({ x: R(), y: 0.62 + R() * 0.3, p: R() * 6, s: 0.4 + R() * 0.6 }));
const CLOUDS = Array.from({ length: 5 }, (_, i) => ({ x: R(), y: 0.12 + R() * 0.3, s: 0.6 + R() * 0.8, v: 0.004 + R() * 0.006 }));
const GRASS = Array.from({ length: 70 }, () => ({ u: R() * 2 - 1, h: 14 + R() * 22, p: R() * 6 }));
const FLOWERS = Array.from({ length: 12 }, () => ({ u: (R() * 2 - 1) * 0.85, c: ['#ffd84d', '#ff8fb1', '#ffffff', '#b7a4ff'][Math.floor(R() * 4)] }));

function sky(e) {
  const n = e.night, d = e.dusk * (1 - n * 0.4);
  const top = mixA(mixA('#5fb4ff', '#0a1030', n), '#4b3d8f', d * 0.7);
  const bot = mixA(mixA('#d6f0ff', '#1f2a5a', n), '#ff9e6b', d);
  return { top, bot };
}

function background(ctx, e) {
  const { w, h, t } = e, n = e.night;
  const s = sky(e);
  const g = ctx.createLinearGradient(0, 0, 0, h * 0.8); g.addColorStop(0, css(s.top)); g.addColorStop(1, css(s.bot));
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  // stars
  if (n > 0.05) for (const st of STARS) { ctx.fillStyle = `rgba(255,255,255,${n * (0.55 + 0.45 * Math.sin(t * 1.3 + st.p))})`; ctx.fillRect(st.x * w, st.y * h, st.r, st.r); }
  // sun / moon
  const mx = w * 0.62, my = h * 0.2;
  if (n < 0.95) {
    const a = 1 - n, gl = ctx.createRadialGradient(mx, my, 0, mx, my, h * 0.22);
    gl.addColorStop(0, `rgba(255,240,190,${0.55 * a})`); gl.addColorStop(1, 'rgba(255,240,190,0)');
    ctx.fillStyle = gl; ctx.fillRect(mx - h * 0.25, my - h * 0.25, h * 0.5, h * 0.5);
    ctx.fillStyle = mix('#fff6d6', '#ffb36b', e.dusk, a); ell(ctx, mx, my + n * 80, h * 0.055, h * 0.055); ctx.fill();
  }
  if (n > 0.05) {
    const gl = ctx.createRadialGradient(mx, my, 0, mx, my, h * 0.18);
    gl.addColorStop(0, `rgba(200,215,255,${0.3 * n})`); gl.addColorStop(1, 'rgba(200,215,255,0)');
    ctx.fillStyle = gl; ctx.fillRect(mx - h * 0.2, my - h * 0.2, h * 0.4, h * 0.4);
    ctx.save(); ctx.globalAlpha = n; ctx.fillStyle = '#f2f4ff'; ell(ctx, mx, my, h * 0.05, h * 0.05); ctx.fill();
    ctx.globalCompositeOperation = 'destination-out'; ell(ctx, mx + h * 0.022, my - h * 0.012, h * 0.045, h * 0.045); ctx.fill(); ctx.restore();
  }
  // clouds
  for (const c of CLOUDS) {
    const x = (((c.x + t * c.v * 0.1) % 1.3) - 0.15) * w, y = c.y * h, s2 = c.s * h / 1080;
    ctx.fillStyle = mix('#ffffff', '#3a4570', n, 0.85 - n * 0.4);
    for (const [dx, dy, r] of [[-70, 10, 45], [-20, -12, 60], [40, 0, 50], [85, 14, 36], [0, 18, 55]]) { ell(ctx, x + dx * s2, y + dy * s2, r * s2 * 1.2, r * s2); ctx.fill(); }
  }
  // far hills
  const k = h / 1080;
  ctx.fillStyle = mix(mixA('#8fcf7a', '#1a2b45', n), '#c27a6a', e.dusk * 0.35);
  ctx.beginPath(); ctx.moveTo(0, h);
  for (let x = 0; x <= w; x += 20) ctx.lineTo(x, h * 0.66 + Math.sin(x / w * 7 + 1) * 40 * k + Math.sin(x / w * 17) * 16 * k);
  ctx.lineTo(w, h); ctx.fill();
  ctx.fillStyle = mix(mixA('#6fb85e', '#152238', n), '#a0604f', e.dusk * 0.3);
  ctx.beginPath(); ctx.moveTo(0, h);
  for (let x = 0; x <= w; x += 20) ctx.lineTo(x, h * 0.74 + Math.sin(x / w * 5 + 3) * 30 * k);
  ctx.lineTo(w, h); ctx.fill();
  // the fox's hill
  const hx = e.cx, hy = e.gy, rx = w * 0.42, ry = h * 0.3;
  const hg = ctx.createLinearGradient(0, hy, 0, h); hg.addColorStop(0, mix('#64b956', '#1b3040', n)); hg.addColorStop(1, mix('#3f8c3c', '#0d1824', n));
  ctx.fillStyle = hg; ell(ctx, hx, hy + ry - 6 * k, rx, ry); ctx.fill();
  // flowers + grass on the hill top
  for (const f of FLOWERS) {
    const x = hx + f.u * rx * 0.8, y = hy - 6 * k + ry - ry * Math.sqrt(1 - (f.u * 0.8) ** 2) + 14 * k;
    if (Math.abs(f.u) < 0.16) continue;
    ctx.fillStyle = mix(f.c, '#3a4466', n * 0.7);
    for (let i = 0; i < 5; i++) { const a = (i / 5) * Math.PI * 2; ell(ctx, x + Math.cos(a) * 6 * k, y + Math.sin(a) * 6 * k, 5 * k, 5 * k); ctx.fill(); }
    ctx.fillStyle = '#ffcc33'; ell(ctx, x, y, 4 * k, 4 * k); ctx.fill();
  }
  ctx.strokeStyle = mix('#7fd06a', '#24404c', n); ctx.lineWidth = 3 * k; ctx.lineCap = 'round';
  ctx.beginPath();
  for (const gr of GRASS) {
    const x = hx + gr.u * rx * 0.95, base = hy - 6 * k + ry - ry * Math.sqrt(Math.max(0, 1 - (gr.u * 0.95) ** 2)) + 4 * k;
    const sway = Math.sin(t * 1.4 + gr.p + gr.u * 3) * 6 * k;
    ctx.moveTo(x, base); ctx.quadraticCurveTo(x + sway * 0.4, base - gr.h * k * 0.6, x + sway, base - gr.h * k);
  }
  ctx.stroke();
  // fireflies
  if (n > 0.3) for (const f of FLIES) {
    const x = (f.x + Math.sin(t * 0.2 * f.s + f.p) * 0.04) * w, y = (f.y + Math.cos(t * 0.27 * f.s + f.p) * 0.03) * h;
    const a = n * (0.4 + 0.6 * Math.max(0, Math.sin(t * 2 * f.s + f.p)));
    const fg = ctx.createRadialGradient(x, y, 0, x, y, 14 * k); fg.addColorStop(0, `rgba(255,240,140,${a})`); fg.addColorStop(1, 'rgba(255,240,140,0)');
    ctx.fillStyle = fg; ctx.fillRect(x - 14 * k, y - 14 * k, 28 * k, 28 * k);
  }
}

function creature(ctx, e) {
  const g = e.grow, b = e.breathe, sl = e.sleep, hot = e.hot, wo = e.worry, pa = e.party, hp = e.happy;
  const dim = 1 - sl * 0.25;
  const fur = (c) => mix(c, '#2a2350', 1 - dim);
  ctx.save(); ctx.scale(g, g);
  // shadow
  ctx.fillStyle = 'rgba(0,0,0,.22)'; ell(ctx, 10, 2, 150, 18); ctx.fill();

  // tail (behind), wagging
  ctx.save(); ctx.translate(58, -30);
  const wagSpeed = 1.3 + pa * 7 + hp * 4, wagAmp = (0.08 + pa * 0.22 + hp * 0.14) * (1 - sl);
  ctx.rotate(Math.sin(e.t * wagSpeed) * wagAmp + sl * 0.35 - 0.05);
  ctx.beginPath(); ctx.moveTo(0, 0);
  ctx.bezierCurveTo(80, 28, 196, 22, 206, -72); ctx.bezierCurveTo(212, -140, 160, -178, 118, -160);
  ctx.bezierCurveTo(150, -118, 128, -44, -6, -48); ctx.closePath();
  let gr = ctx.createLinearGradient(0, -160, 200, 0); gr.addColorStop(0, fur('#f39a48')); gr.addColorStop(1, fur('#d2622a'));
  ctx.fillStyle = gr; ctx.fill();
  ctx.save(); ctx.clip(); ctx.fillStyle = fur('#fff4e6'); ell(ctx, 178, -146, 58, 50, 0.5); ctx.fill(); ctx.restore();
  ctx.restore();

  // body
  ctx.save(); ctx.scale(1 + 0.014 * b, 1 + 0.026 * b);
  ctx.beginPath(); ctx.moveTo(-94, 0);
  ctx.bezierCurveTo(-114, -72, -90, -188, 0, -198); ctx.bezierCurveTo(90, -188, 114, -72, 94, 0); ctx.closePath();
  gr = ctx.createLinearGradient(-90, -190, 90, 0); gr.addColorStop(0, fur('#f8a656')); gr.addColorStop(1, fur('#d96a2b'));
  ctx.fillStyle = gr; ctx.fill();
  ctx.beginPath(); ctx.moveTo(-50, -180);
  ctx.bezierCurveTo(-72, -110, -46, -40, 0, -16); ctx.bezierCurveTo(46, -40, 72, -110, 50, -180);
  ctx.bezierCurveTo(22, -160, -22, -160, -50, -180); ctx.closePath();
  ctx.fillStyle = fur('#fff6ec'); ctx.fill();
  ctx.restore();

  // front legs with dark socks
  for (const sx of [-1, 1]) {
    const x = sx * 40 - 18;
    gr = ctx.createLinearGradient(0, -118, 0, 0); gr.addColorStop(0, fur('#e57a32')); gr.addColorStop(0.45, fur('#a8502a')); gr.addColorStop(0.6, fur('#3d241a')); gr.addColorStop(1, fur('#2c1a13'));
    ctx.fillStyle = gr; ctx.beginPath(); ctx.roundRect(x, -118, 36, 120, 18); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.lineWidth = 2.5; ctx.beginPath();
    ctx.moveTo(x + 12, -2); ctx.lineTo(x + 12, -12); ctx.moveTo(x + 24, -2); ctx.lineTo(x + 24, -12); ctx.stroke();
  }

  // head
  const hy = -268 - b * 5 + sl * 22;
  const tilt = e.tilt * 0.13 + sl * 0.16 + wo * -0.05;
  ctx.save(); ctx.translate(0, hy); ctx.rotate(tilt);
  // ears (behind head): droop when sleepy/hot/worried, twitch on fidget
  const droop = sl * 0.45 + hot * 0.18 + wo * 0.5;
  const tw = e.fidget < 0.35 ? Math.sin((e.fidget / 0.35) * Math.PI * 2) * 0.18 : 0;
  for (const sx of [-1, 1]) {
    ctx.save(); ctx.translate(sx * 62, -70); ctx.rotate(sx * droop + (sx < 0 ? tw : 0));
    ctx.beginPath(); ctx.moveTo(sx * -40, 22); ctx.quadraticCurveTo(sx * -46, -60, sx * -32, -108); ctx.quadraticCurveTo(sx * 18, -70, sx * 42, -12); ctx.closePath();
    ctx.fillStyle = fur('#e9813a'); ctx.fill();
    ctx.beginPath(); ctx.moveTo(sx * -26, 10); ctx.quadraticCurveTo(sx * -32, -50, sx * -26, -82); ctx.quadraticCurveTo(sx * 6, -52, sx * 24, -10); ctx.closePath();
    ctx.fillStyle = fur('#4a2117'); ctx.fill();
    ctx.restore();
  }
  // head shape with cheek tufts
  ctx.beginPath(); ctx.moveTo(0, -95);
  ctx.bezierCurveTo(70, -95, 118, -52, 122, 0); ctx.lineTo(156, 36); ctx.lineTo(114, 50);
  ctx.bezierCurveTo(96, 74, 52, 92, 0, 94); ctx.bezierCurveTo(-52, 92, -96, 74, -114, 50);
  ctx.lineTo(-156, 36); ctx.lineTo(-122, 0); ctx.bezierCurveTo(-118, -52, -70, -95, 0, -95); ctx.closePath();
  gr = ctx.createLinearGradient(-100, -95, 100, 90); gr.addColorStop(0, fur('#f9a85a')); gr.addColorStop(1, fur('#e0702e'));
  ctx.fillStyle = gr; ctx.fill();
  // white mask
  ctx.beginPath(); ctx.moveTo(-154, 36); ctx.lineTo(-114, 50);
  ctx.bezierCurveTo(-96, 74, -52, 92, 0, 94); ctx.bezierCurveTo(52, 92, 96, 74, 114, 50); ctx.lineTo(154, 36);
  ctx.bezierCurveTo(120, 42, 92, 30, 72, 16); ctx.bezierCurveTo(46, 0, 24, 10, 0, 26);
  ctx.bezierCurveTo(-24, 10, -46, 0, -72, 16); ctx.bezierCurveTo(-92, 30, -120, 42, -154, 36); ctx.closePath();
  ctx.fillStyle = fur('#fff6ec'); ctx.fill();

  // blush
  ctx.fillStyle = `rgba(255,105,120,${0.22 + hot * 0.45 + pa * 0.2 + hp * 0.1})`;
  ell(ctx, -80, 34, 22, 12); ctx.fill(); ell(ctx, 80, 34, 22, 12); ctx.fill();

  // eyes
  const closed = Math.max(e.blink, clamp((sl - 0.4) * 2.5));
  const happyEyes = Math.max(pa, hp) > 0.5 && sl < 0.4;
  const lx = e.lookX * 7, ly = e.lookY * 5;
  ctx.lineCap = 'round'; ctx.strokeStyle = '#1c1210'; ctx.lineWidth = 6;
  for (const sx of [-1, 1]) {
    const ex = sx * 48;
    if (happyEyes) { ctx.beginPath(); ctx.arc(ex, 4, 15, Math.PI * 1.15, Math.PI * 1.85); ctx.stroke(); continue; }
    if (closed > 0.85) { ctx.beginPath(); ctx.arc(ex, -6, 14, Math.PI * 0.15, Math.PI * 0.85); ctx.stroke(); continue; }
    const open = 1 - closed, ry = (wo > 0.4 ? 23 : 21) * open;
    ctx.fillStyle = '#1c1210'; ell(ctx, ex + lx, -4 + ly, 17, ry); ctx.fill();
    if (open > 0.4) {
      ctx.fillStyle = '#fff'; ell(ctx, ex + lx - 6, -12 + ly, 6.5, 6.5); ctx.fill(); ell(ctx, ex + lx + 6, 4 + ly, 3, 3); ctx.fill();
      if (wo > 0.4) { ctx.fillStyle = 'rgba(160,220,255,.9)'; ell(ctx, ex + lx, 14 + ly, 9, 4); ctx.fill(); }
    }
  }
  // worried brows
  if (wo > 0.05) {
    ctx.strokeStyle = `rgba(60,25,15,${wo})`; ctx.lineWidth = 6;
    ctx.beginPath(); ctx.moveTo(-70, -34); ctx.lineTo(-30, -46); ctx.moveTo(70, -34); ctx.lineTo(30, -46); ctx.stroke();
  }
  // nose
  ctx.fillStyle = '#1b1111'; ctx.beginPath(); ctx.moveTo(-14, 32); ctx.quadraticCurveTo(0, 26, 14, 32); ctx.quadraticCurveTo(9, 47, 0, 49); ctx.quadraticCurveTo(-9, 47, -14, 32); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,.5)'; ell(ctx, -4, 32, 4, 2.5); ctx.fill();
  // mouth
  const pant = hot > 0.4 && sl < 0.5 ? (0.5 + 0.5 * Math.abs(Math.sin(e.t * 6))) * hot : 0;
  const open = Math.max(e.eatOpen, pant * 0.8, pa * (0.55 + 0.25 * Math.sin(e.t * 6.5)));
  ctx.strokeStyle = '#3b2018'; ctx.lineWidth = 4.5;
  if (open > 0.08) {
    ctx.fillStyle = '#5e1a1f'; ell(ctx, 0, 62 + open * 8, 16 + open * 6, 4 + open * 17); ctx.fill();
    ctx.fillStyle = '#ff7b8a';
    if (pant > 0.1) { ctx.beginPath(); ctx.roundRect(-11, 62, 22, 26 + pant * 18, 11); ctx.fill(); ctx.strokeStyle = 'rgba(180,40,60,.6)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(0, 70); ctx.lineTo(0, 82 + pant * 10); ctx.stroke(); }
    else { ell(ctx, 0, 66 + open * 18, 11 + open * 4, 5 + open * 5); ctx.fill(); }
  } else if (wo > 0.4) {
    ctx.beginPath(); ctx.moveTo(-14, 64); ctx.quadraticCurveTo(-7, 57, 0, 63); ctx.quadraticCurveTo(7, 69, 14, 62); ctx.stroke();
  } else {
    ctx.beginPath(); ctx.moveTo(0, 49); ctx.lineTo(0, 57); ctx.moveTo(-17, 59); ctx.quadraticCurveTo(-8, 68, 0, 57); ctx.quadraticCurveTo(8, 68, 17, 59); ctx.stroke();
  }
  // hats
  PU.partyHat(ctx, 34, -86, backOut(pa) * 0.95, 0.38);
  PU.nightcap(ctx, -10, -78, clamp(sl * 1.4 - 0.3) * (1 - pa), -0.12, e.t);
  ctx.restore();   // head
  ctx.restore();   // grow
  return { head: { x: 0, y: (hy - 10) * g, r: 125 * g }, mouth: { x: 0, y: (hy + 62) * g } };
}

PET_STYLES.fox = { name: 'Kit', label: 'Vector fox', ground: 0.8, background, creature };
})();
