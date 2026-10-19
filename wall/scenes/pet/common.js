// Shared helpers for the Life-pet scene. Styles register themselves in window.PET_STYLES.
window.PET_STYLES = {};
window.PU = (() => {
  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const hex = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  // mix('#ff0000', '#0000ff', .5) -> 'rgb(128,0,128)'; chained mixing goes through arrays
  const mixA = (a, b, t) => { a = typeof a === 'string' ? hex(a) : a; b = typeof b === 'string' ? hex(b) : b; return a.map((v, i) => Math.round(lerp(v, b[i], clamp(t)))); };
  const css = (c, alpha = 1) => `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
  const mix = (a, b, t, alpha = 1) => css(mixA(a, b, t), alpha);
  const rng = (seed) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const ell = (ctx, x, y, rx, ry, rot = 0) => { ctx.beginPath(); ctx.ellipse(x, y, Math.max(0.01, rx), Math.max(0.01, ry), rot, 0, Math.PI * 2); };
  const backOut = (t) => { t = clamp(t); const c = 1.7; return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2; };
  // 0 = day, 1 = night; dusk = 0..1 bell around sunset/sunrise
  const night = (h) => (h >= 7 && h < 17.5 ? 0 : h >= 17.5 && h < 20 ? (h - 17.5) / 2.5 : h >= 20 || h < 5.5 ? 1 : 1 - (h - 5.5) / 1.5);
  const dusk = (h) => Math.max(0, 1 - Math.abs(h - 18.6) / 1.6, 1 - Math.abs(h - 6.3) / 1.1);

  // Party hat and nightcap, shared by the vector styles. (x, y) is where the brim sits.
  function partyHat(ctx, x, y, s, rot) {
    if (s <= 0.01) return;
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.scale(s, s);
    ctx.beginPath(); ctx.moveTo(-34, 0); ctx.lineTo(0, -100); ctx.lineTo(34, 0); ctx.closePath();
    ctx.fillStyle = '#ff4f8b'; ctx.fill();
    ctx.save(); ctx.clip(); ctx.fillStyle = '#ffd84d';
    for (let i = -3; i < 4; i++) { ctx.beginPath(); ctx.moveTo(i * 30 - 40, 0); ctx.lineTo(i * 30 - 26, 0); ctx.lineTo(i * 30 + 34, -110); ctx.lineTo(i * 30 + 20, -110); ctx.fill(); }
    ctx.restore();
    ctx.fillStyle = '#7cf0c5'; ell(ctx, 0, 0, 38, 8); ctx.fill();
    ctx.fillStyle = '#fff'; ell(ctx, 0, -102, 13, 13); ctx.fill();
    ctx.restore();
  }
  function nightcap(ctx, x, y, s, rot, t) {
    if (s <= 0.01) return;
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.scale(s, s);
    const sway = Math.sin(t * 0.8) * 8;
    ctx.beginPath(); ctx.moveTo(-60, 0);
    ctx.bezierCurveTo(-55, -70, 10, -110, 75 + sway, -60);
    ctx.bezierCurveTo(50, -75, 30, -40, 60, 0); ctx.closePath();
    const g = ctx.createLinearGradient(-60, -90, 60, 0); g.addColorStop(0, '#6c7cff'); g.addColorStop(1, '#3a43a8');
    ctx.fillStyle = g; ctx.fill();
    ctx.fillStyle = '#f4f2ff'; ell(ctx, 0, 0, 66, 14); ctx.fill();
    ell(ctx, 78 + sway, -58, 15, 15); ctx.fill();
    ctx.restore();
  }
  return { clamp, lerp, hex, mixA, css, mix, rng, ell, backOut, night, dusk, partyHat, nightcap };
})();
