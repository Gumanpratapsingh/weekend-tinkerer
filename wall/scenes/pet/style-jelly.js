// "Glo", a glowing jellyfish in a deep ocean. Its colour follows its mood.
(() => {
const { ell, rng, clamp, lerp, backOut } = PU;
const R = rng(21);
const SNOW = Array.from({ length: 90 }, () => ({ x: R(), y: R(), r: 0.8 + R() * 2.2, v: 0.004 + R() * 0.01, p: R() * 6 }));
const BUBBLES = Array.from({ length: 14 }, () => ({ x: R(), y: R(), r: 4 + R() * 10, v: 0.03 + R() * 0.04, p: R() * 6 }));
const KELP = Array.from({ length: 9 }, (_, i) => ({ x: i < 5 ? 0.02 + R() * 0.22 : 0.72 + R() * 0.26, h: 0.25 + R() * 0.35, p: R() * 6, w: 10 + R() * 10 }));
const CORAL = Array.from({ length: 26 }, () => ({ x: R(), y: 0.9 + R() * 0.08, r: 3 + R() * 6, hue: [320, 190, 50, 270][Math.floor(R() * 4)], p: R() * 6 }));

function background(ctx, e) {
  const { w, h, t } = e, n = e.night, k = h / 1080;
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, `hsl(${lerp(200, 225, n)}, ${lerp(70, 60, n)}%, ${lerp(30, 11, n)}%)`);
  g.addColorStop(0.55, `hsl(${lerp(210, 230, n)}, 70%, ${lerp(14, 6, n)}%)`);
  g.addColorStop(1, `hsl(230, 60%, ${lerp(5, 3, n)}%)`);
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  // light rays from the surface
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  const ra = 0.07 * (1 - n * 0.75);
  for (let i = 0; i < 6; i++) {
    const x = w * (0.1 + i * 0.17) + Math.sin(t * 0.15 + i * 2) * w * 0.04, sp = w * (0.05 + (i % 3) * 0.02);
    const rg = ctx.createLinearGradient(0, 0, 0, h * 0.9); rg.addColorStop(0, `rgba(170,230,255,${ra})`); rg.addColorStop(1, 'rgba(170,230,255,0)');
    ctx.fillStyle = rg; ctx.beginPath(); ctx.moveTo(x - sp * 0.4, 0); ctx.lineTo(x + sp * 0.4, 0); ctx.lineTo(x + sp * 2 + w * 0.08, h * 0.9); ctx.lineTo(x + sp * 0.4 + w * 0.08, h * 0.9); ctx.fill();
  }
  ctx.restore();
  // marine snow drifting up, bubbles
  for (const s of SNOW) {
    const y = ((s.y - t * s.v) % 1 + 1) % 1, x = s.x + Math.sin(t * 0.3 + s.p) * 0.01;
    ctx.fillStyle = `rgba(200,235,255,${0.25 + 0.2 * Math.sin(t + s.p)})`; ctx.fillRect(x * w, y * h, s.r * k, s.r * k);
  }
  ctx.lineWidth = 2 * k;
  for (const b of BUBBLES) {
    const y = ((b.y - t * b.v) % 1 + 1) % 1, x = (b.x + Math.sin(t * 1.5 + b.p) * 0.006) * w;
    ctx.strokeStyle = 'rgba(200,240,255,.35)'; ell(ctx, x, y * h, b.r * k, b.r * k); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,.35)'; ell(ctx, x - b.r * 0.35 * k, y * h - b.r * 0.35 * k, b.r * 0.25 * k, b.r * 0.25 * k); ctx.fill();
  }
  // sea floor
  ctx.fillStyle = `hsl(220, 45%, ${lerp(9, 4, n)}%)`;
  ctx.beginPath(); ctx.moveTo(0, h);
  for (let x = 0; x <= w; x += 24) ctx.lineTo(x, h * 0.9 + Math.sin(x / w * 6 + 1) * 22 * k + Math.sin(x / w * 19) * 8 * k);
  ctx.lineTo(w, h); ctx.fill();
  // kelp
  ctx.lineCap = 'round';
  for (const kl of KELP) {
    const x0 = kl.x * w, y0 = h * 0.95, top = y0 - kl.h * h;
    ctx.strokeStyle = `hsla(${lerp(150, 185, n)}, 45%, ${lerp(22, 12, n)}%, .95)`; ctx.lineWidth = kl.w * k;
    ctx.beginPath(); ctx.moveTo(x0, y0);
    for (let j = 1; j <= 10; j++) { const yy = lerp(y0, top, j / 10); ctx.lineTo(x0 + Math.sin(t * 0.7 + kl.p + j * 0.5) * j * 4 * k, yy); }
    ctx.stroke();
  }
  // glowing coral dots, brighter at night
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  for (const c of CORAL) {
    const a = (0.2 + 0.5 * n) * (0.6 + 0.4 * Math.sin(t * 1.2 + c.p)), x = c.x * w, y = c.y * h, r = c.r * k * 3;
    const cg = ctx.createRadialGradient(x, y, 0, x, y, r); cg.addColorStop(0, `hsla(${c.hue},100%,70%,${a})`); cg.addColorStop(1, `hsla(${c.hue},100%,60%,0)`);
    ctx.fillStyle = cg; ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  ctx.restore();
}

function creature(ctx, e) {
  const g = e.grow, b = e.breathe, sl = e.sleep, hot = e.hot, wo = e.worry, pa = e.party, hp = e.happy;
  // mood colour
  let hue = hot > 0.01 ? lerp(172, 12, Math.pow(hot, 0.35)) : 172;   // amber when warm, red-orange when hot hue = lerp(hue, 215, wo * 0.8); hue = lerp(hue, 238, sl);
  if (pa > 0.02) hue = lerp(hue, (e.t * 140) % 360, pa);
  const sat = lerp(90, 45, wo * 0.6), lit = lerp(62, 48, sl), glowA = lerp(0.42, 0.2, sl) + pa * 0.15 + hp * 0.1;
  const fl = Math.sin(e.t * 0.9) * 18 * (1 - sl * 0.5) + sl * 30;
  const sx = 1 - 0.07 * b, sy = 1 + 0.06 * b;
  ctx.save(); ctx.scale(g, g); ctx.translate(0, fl);

  // glow halo
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  let gr = ctx.createRadialGradient(0, -70, 20, 0, -40, 380);
  gr.addColorStop(0, `hsla(${hue},100%,65%,${glowA})`); gr.addColorStop(1, `hsla(${hue},100%,55%,0)`);
  ctx.fillStyle = gr; ctx.fillRect(-400, -440, 800, 800);
  ctx.restore();

  // tentacles
  const N = 6 + Math.min(4, Math.floor(e.level / 6)), calm = 1 - sl * 0.6, len = 250 + Math.min(80, e.level * 3);
  ctx.lineCap = 'round';
  for (let pass = 0; pass < 2; pass++) {
    ctx.lineWidth = pass ? 3.5 : 10; ctx.strokeStyle = `hsla(${hue + 15},${sat}%,${pass ? 85 : 70}%,${pass ? 0.75 : 0.22})`;
    for (let i = 0; i < N; i++) {
      const x0 = lerp(-118, 118, i / (N - 1)) * sx;
      ctx.beginPath(); ctx.moveTo(x0, 6);
      for (let j = 1; j <= 14; j++) {
        const y = (j / 14) * len * (0.85 + 0.15 * Math.sin(i * 1.7));
        ctx.lineTo(x0 * (1 - j * 0.02) + Math.sin(e.t * 1.7 + i * 0.9 - j * 0.42) * (4 + j * 2.2) * calm, y);
      }
      ctx.stroke();
    }
  }
  // two frilly oral arms
  for (const s of [-1, 1]) {
    for (let pass = 0; pass < 2; pass++) {
      ctx.lineWidth = pass ? 7 : 20; ctx.strokeStyle = `hsla(${hue + 30},${sat}%,${pass ? 82 : 66}%,${pass ? 0.6 : 0.3})`;
      ctx.beginPath(); ctx.moveTo(s * 26, 4);
      for (let j = 1; j <= 12; j++) ctx.lineTo(s * (26 - j * 1.5) + Math.sin(e.t * 1.2 + j * 0.6 + s) * (6 + j * 1.6) * calm, j * 17);
      ctx.stroke();
    }
  }

  // bell
  const bell = () => {
    ctx.beginPath(); ctx.moveTo(-150 * sx, 0);
    ctx.bezierCurveTo(-162 * sx, -205 * sy, 162 * sx, -205 * sy, 150 * sx, 0);
    const S = 9;
    for (let i = 0; i < S; i++) {
      const x1 = lerp(150, -150, (i + 0.5) / S) * sx, x2 = lerp(150, -150, (i + 1) / S) * sx;
      ctx.quadraticCurveTo(x1, 20 + Math.sin(e.t * 3 + i) * 3, x2, 0);
    }
    ctx.closePath();
  };
  bell();
  gr = ctx.createRadialGradient(-40, -120, 10, 0, -60, 220);
  gr.addColorStop(0, `hsla(${hue},${sat}%,${lit + 28}%,.97)`); gr.addColorStop(0.55, `hsla(${hue},${sat}%,${lit}%,.82)`); gr.addColorStop(1, `hsla(${hue + 20},${sat}%,${lit - 16}%,.7)`);
  ctx.fillStyle = gr; ctx.fill();
  ctx.lineWidth = 4; ctx.strokeStyle = `hsla(${hue},100%,92%,.55)`; ctx.stroke();
  // moon-jelly petals
  ctx.save(); ctx.translate(0, -78); ctx.rotate(e.t * 0.08);
  ctx.fillStyle = `hsla(${hue + 40},90%,85%,.22)`;
  for (let i = 0; i < 4; i++) { ctx.rotate(Math.PI / 2); ell(ctx, 0, -30, 16, 28); ctx.fill(); }
  ctx.restore();
  // sheen
  ctx.fillStyle = 'rgba(255,255,255,.35)'; ell(ctx, -70 * sx, -110 * sy, 42, 16, -0.55); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,.5)'; ell(ctx, -98 * sx, -84 * sy, 9, 6, -0.6); ctx.fill();

  // face
  const fy = -46 * sy;
  ctx.fillStyle = `rgba(255,120,150,${0.28 + hot * 0.4 + pa * 0.2 + hp * 0.12})`;
  ell(ctx, -84, fy + 26, 20, 10); ctx.fill(); ell(ctx, 84, fy + 26, 20, 10); ctx.fill();
  const closed = Math.max(e.blink, clamp((sl - 0.4) * 2.5)), happyEyes = Math.max(pa, hp) > 0.5 && sl < 0.4;
  const lx = e.lookX * 7, ly = e.lookY * 5;
  ctx.strokeStyle = '#0f1d33'; ctx.lineWidth = 6; ctx.lineCap = 'round';
  for (const s of [-1, 1]) {
    const ex = s * 50;
    if (happyEyes) { ctx.beginPath(); ctx.arc(ex, fy + 6, 16, Math.PI * 1.15, Math.PI * 1.85); ctx.stroke(); continue; }
    if (closed > 0.85) { ctx.beginPath(); ctx.arc(ex, fy - 4, 15, Math.PI * 0.15, Math.PI * 0.85); ctx.stroke(); continue; }
    const open = 1 - closed;
    ctx.fillStyle = '#0f1d33'; ell(ctx, ex + lx, fy + ly - 2, 21, 25 * open); ctx.fill();
    if (open > 0.4) { ctx.fillStyle = '#fff'; ell(ctx, ex + lx - 7, fy + ly - 11, 8, 8); ctx.fill(); ell(ctx, ex + lx + 7, fy + ly + 6, 3.5, 3.5); ctx.fill(); }
  }
  if (wo > 0.05) { ctx.strokeStyle = `rgba(15,29,51,${wo})`; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(-74, fy - 36); ctx.lineTo(-34, fy - 46); ctx.moveTo(74, fy - 36); ctx.lineTo(34, fy - 46); ctx.stroke(); }
  const pant = hot > 0.4 && sl < 0.5 ? (0.5 + 0.5 * Math.abs(Math.sin(e.t * 6))) * hot : 0;
  const open = Math.max(e.eatOpen, pant * 0.8, pa * (0.55 + 0.25 * Math.sin(e.t * 6.5)));
  const my = fy + 34;
  ctx.strokeStyle = '#0f1d33'; ctx.lineWidth = 5;
  if (open > 0.08) {
    ctx.fillStyle = '#3a1030'; ell(ctx, 0, my + open * 8, 14 + open * 6, 3 + open * 15); ctx.fill();
    ctx.fillStyle = '#ff7b9c';
    if (pant > 0.1) { ctx.beginPath(); ctx.roundRect(-10, my + 6, 20, 20 + pant * 16, 10); ctx.fill(); }
    else { ell(ctx, 0, my + 4 + open * 16, 9 + open * 4, 4 + open * 4); ctx.fill(); }
  } else if (wo > 0.4) { ctx.beginPath(); ctx.moveTo(-14, my + 6); ctx.quadraticCurveTo(-7, my, 0, my + 6); ctx.quadraticCurveTo(7, my + 12, 14, my + 5); ctx.stroke(); }
  else { ctx.beginPath(); ctx.arc(0, my - 8, 15, Math.PI * 0.2, Math.PI * 0.8); ctx.stroke(); }

  PU.partyHat(ctx, 40, -150 * sy, backOut(pa), 0.32);
  PU.nightcap(ctx, -8, -150 * sy, clamp(sl * 1.4 - 0.3) * (1 - pa), -0.1, e.t);
  ctx.restore();
  return { head: { x: 0, y: (-90 + fl) * g, r: 155 * g }, mouth: { x: 0, y: (my + fl) * g } };
}

PET_STYLES.jelly = { name: 'Glo', label: 'Glowing jelly', ground: 0.56, background, creature };
})();
