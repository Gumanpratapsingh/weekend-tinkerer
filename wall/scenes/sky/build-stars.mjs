// Builds scenes/sky/stars.json from the Yale Bright Star Catalogue (BSC5) and d3-celestial constellation lines.
import { readFileSync, writeFileSync } from 'node:fs';
const [dl, out] = process.argv.slice(2);
const bsc = JSON.parse(readFileSync(dl + '/bsc5.json', 'utf8'));
const lines = JSON.parse(readFileSync(dl + '/lines.json', 'utf8'));
const cons = JSON.parse(readFileSync(dl + '/cons.json', 'utf8'));

const NAMES = { // HR number → proper name [expected constellation]
  2491: ['Sirius', 'CMa'], 2326: ['Canopus', 'Car'], 5340: ['Arcturus', 'Boo'], 5459: ['Rigil Kent', 'Cen'],
  7001: ['Vega', 'Lyr'], 1708: ['Capella', 'Aur'], 1713: ['Rigel', 'Ori'], 2943: ['Procyon', 'CMi'],
  2061: ['Betelgeuse', 'Ori'], 472: ['Achernar', 'Eri'], 5267: ['Hadar', 'Cen'], 7557: ['Altair', 'Aql'],
  4730: ['Acrux', 'Cru'], 1457: ['Aldebaran', 'Tau'], 6134: ['Antares', 'Sco'], 5056: ['Spica', 'Vir'],
  2990: ['Pollux', 'Gem'], 8728: ['Fomalhaut', 'PsA'], 7924: ['Deneb', 'Cyg'], 4853: ['Mimosa', 'Cru'],
  3982: ['Regulus', 'Leo'], 2618: ['Adhara', 'CMa'], 2891: ['Castor', 'Gem'], 6527: ['Shaula', 'Sco'],
  4763: ['Gacrux', 'Cru'], 1790: ['Bellatrix', 'Ori'], 1791: ['Elnath', 'Tau'], 3685: ['Miaplacidus', 'Car'],
  1903: ['Alnilam', 'Ori'], 8425: ['Alnair', 'Gru'], 1948: ['Alnitak', 'Ori'], 4905: ['Alioth', 'UMa'],
  4301: ['Dubhe', 'UMa'], 1017: ['Mirfak', 'Per'], 2693: ['Wezen', 'CMa'], 6553: ['Sargas', 'Sco'],
  6879: ['Kaus Australis', 'Sgr'], 3307: ['Avior', 'Car'], 5191: ['Alkaid', 'UMa'], 2088: ['Menkalinan', 'Aur'],
  6217: ['Atria', 'TrA'], 2421: ['Alhena', 'Gem'], 7790: ['Peacock', 'Pav'], 424: ['Polaris', 'UMi'],
  2294: ['Mirzam', 'CMa'], 3748: ['Alphard', 'Hya'], 617: ['Hamal', 'Ari'], 188: ['Diphda', 'Cet'],
  7121: ['Nunki', 'Sgr'], 5288: ['Menkent', 'Cen'], 2004: ['Saiph', 'Ori'], 15: ['Alpheratz', 'And'],
  5054: ['Mizar', 'UMa'], 5563: ['Kochab', 'UMi'], 6556: ['Rasalhague', 'Oph'], 936: ['Algol', 'Per'],
  4534: ['Denebola', 'Leo'], 1852: ['Mintaka', 'Ori'], 168: ['Schedar', 'Cas'], 8162: ['Alderamin', 'Cep'],
  8781: ['Markab', 'Peg'], 8775: ['Scheat', 'Peg'], 8308: ['Enif', 'Peg'], 7796: ['Sadr', 'Cyg'],
  7417: ['Albireo', 'Cyg'], 337: ['Mirach', 'And'], 603: ['Almach', 'And'], 911: ['Menkar', 'Cet'],
  1165: ['Alcyone', 'Tau'], 5793: ['Alphecca', 'CrB'], 6705: ['Eltanin', 'Dra'], 7525: ['Tarazed', 'Aql'],
  3634: ['Suhail', 'Vel'], 4819: ['Muhlifain', 'Cen'], 8636: ['Tiaki', 'Gru'], 99: ['Ankaa', 'Phe'],
};

const toH = s => { const m = s.match(/(\d+)h\s*(\d+)m\s*([\d.]+)s/); return +m[1] + m[2] / 60 + m[3] / 3600; };
const toD = s => { const m = s.match(/([+-])(\d+)°\s*(\d+)′\s*([\d.]+)″/); const v = +m[2] + m[3] / 60 + m[4] / 3600; return m[1] === '-' ? -v : v; };
const LIMIT = 5.0;
const stars = [];
for (const s of bsc) {
  const v = parseFloat(s.V); if (!(v <= LIMIT)) continue;
  const hr = +s.HR, n = NAMES[hr];
  if (n && s.C !== n[1]) throw new Error(`HR ${hr} is in ${s.C}, expected ${n[1]} for ${n[0]}`);
  const row = [+toH(s.RA).toFixed(4), +toD(s.Dec).toFixed(3), v, +(s.K || 6000)];
  if (n) row.push(n[0]);
  stars.push(row);
}
const missing = Object.keys(NAMES).filter(hr => !bsc.find(s => +s.HR === +hr && parseFloat(s.V) <= LIMIT));
if (missing.length) throw new Error('names not in catalogue: ' + missing);
stars.sort((a, b) => a[2] - b[2]);

const names = Object.fromEntries(cons.features.map(f => [f.id, f.properties.name]));
const centres = Object.fromEntries(cons.features.map(f => [f.id, f.geometry.coordinates]));
const cl = lines.features.map(f => ({
  id: f.id, name: names[f.id] || f.id,
  c: centres[f.id] ? [+(((centres[f.id][0] + 360) % 360) / 15).toFixed(3), +centres[f.id][1].toFixed(2)] : null,
  l: f.geometry.coordinates.map(seg => seg.map(([ra, dec]) => [+(((ra + 360) % 360) / 15).toFixed(4), +dec.toFixed(3)])),
}));
writeFileSync(out, JSON.stringify({
  about: 'Stars brighter than V 5.0 from the Yale Bright Star Catalogue (BSC5, public domain): [RA hours J2000, Dec deg, V mag, temperature K, name?]. Constellation lines from d3-celestial (BSD-3, Olaf Frohn).',
  stars, constellations: cl,
}));
console.log(stars.length, 'stars;', stars.filter(s => s[4]).length, 'named;', cl.length, 'constellations');
