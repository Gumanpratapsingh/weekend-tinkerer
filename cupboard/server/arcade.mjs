// Arcade + monitor: phone gamepad links for the game on the laptop, and which scene the S20's monitor wall shows.
// The gamepad page itself is served by the laptop's arcade bridge (weekend-tinkerer/arcade/pad.py) on the home
// Wi-Fi, because button presses through the internet would lag. Cupboard only signs a short-lived link for it.
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';

const PAD_PORT = 8097;
const LINK_HOURS = 6;
export const SCENES = [
  { id: 'mission', label: 'Mission Control', emoji: '🛰️' },
  { id: 'sky', label: 'Live sky', emoji: '🌌' },
  { id: 'flights', label: 'Flight radar', emoji: '✈️' },
  { id: 'wifi', label: 'Wi-Fi devices', emoji: '📶' },
  { id: 'pet', label: 'Life-pet', emoji: '🐾' },
];
// Per-scene options, picked in Cupboard and handed to the scene as URL parameters (?key=value).
// The first value of each option is the scene's own default, so it is left out of the URL.
export const OPTIONS = {
  flights: [
    { key: 'style', label: 'Look', values: [['neon', 'Neon map'], ['radar', 'Radar sweep']] },
    { key: 'r', label: 'Range', values: [['150', '150 km'], ['80', '80 km'], ['100', '100 km'], ['200', '200 km'], ['250', '250 km']] },
    { key: 'pitch', label: 'Tilt (neon)', values: [['', 'Default'], ['0', 'Flat'], ['30', '30°'], ['60', '60°']] },
    { key: 'labels', label: 'Label cards', values: [['4', '4'], ['0', 'None'], ['2', '2'], ['6', '6']] },
    { key: 'demo', label: 'Data', values: [['', 'Live'], ['1', 'Demo sample']] },
  ],
  pet: [
    { key: 'style', label: 'Creature', values: [['fox', 'Fox'], ['jelly', 'Jelly'], ['pixel', 'Pixel']] },
    { key: 'demo', label: 'Data', values: [['', 'Live'], ['1', 'Demo (every state)']] },
  ],
  sky: [
    { key: 'labels', label: 'Labels', values: [['', 'On'], ['0', 'Off']] },
    { key: 'demo', label: 'Time', values: [['', 'Now'], ['iss', 'Next ISS pass']] },
  ],
};

// The laptop's address on the home Wi-Fi (DHCP may change it, so it's looked up per request).
function lanIp() {
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    if (!/^(wl|en|eth)/.test(name)) continue;
    const a = addrs.find((x) => x.family === 'IPv4' && !x.internal);
    if (a) return a.address;
  }
  return null;
}

export function install({ readJson, send, err, getKv, setKv, log }) {
  const secret = () => readFileSync(join(process.env.HOME, 'arcade', 'secret'), 'utf8').trim();
  const scene = () => getKv('wall:scene', 'mission');
  const allOpts = () => { try { return JSON.parse(getKv('wall:opts', '{}')) || {}; } catch { return {}; } };
  // Only values from OPTIONS, and only non-default ones, so the scene URL stays short.
  const optsFor = (id) => {
    const set = allOpts()[id] || {}, out = {};
    for (const o of OPTIONS[id] || []) if (set[o.key] != null && set[o.key] !== o.values[0][0] && o.values.some((v) => v[0] === set[o.key])) out[o.key] = set[o.key];
    return out;
  };

  async function route(req, res, path, query, me) {
    if (path === '/api/arcade' && req.method === 'GET') {
      const ip = lanIp();
      if (!ip) throw err(503, 'The laptop is not on the Wi-Fi right now.');
      let key; try { key = secret(); } catch { throw err(503, 'The arcade is not set up on the laptop yet.'); }
      const player = me.role === 'owner' ? 1 : 2;
      const raw = `${player}.${Math.floor(Date.now() / 1000) + LINK_HOURS * 3600}.${me.name.split(' ')[0].replace(/[^\p{L}\p{N} ]/gu, '').slice(0, 20)}`;
      const t = Buffer.from(raw).toString('base64url') + '.' + createHmac('sha256', key).update(raw).digest('hex');
      return send(res, 200, { player, link: `http://${ip}:${PAD_PORT}/pad?t=${t}`, sunshine: `https://${ip}:47990`, hours: LINK_HOURS }), true;
    }
    if (path === '/api/wall' && req.method === 'GET') {
      const opts = Object.fromEntries(Object.keys(OPTIONS).map((id) => [id, optsFor(id)]));
      return send(res, 200, { scene: scene(), scenes: SCENES, options: OPTIONS, opts, canSet: me.role === 'owner' }), true;
    }
    if (path === '/api/wall' && req.method === 'POST') {
      if (me.role !== 'owner') throw err(403, 'Only the owner can change the monitor.');
      const b = await readJson(req, 500);
      if (b.scene != null) {                               // {scene}: switch what the monitor shows
        const id = String(b.scene);
        if (!SCENES.some((s) => s.id === id)) throw err(400, 'Unknown scene.');
        setKv('wall:scene', id);
        log(`wall scene -> ${id}`);
      }
      if (b.option) {                                      // {option: {scene, key, value}}: change one scene option
        const { scene: id, key } = b.option, value = String(b.option.value ?? '');
        const o = (OPTIONS[id] || []).find((x) => x.key === key);
        if (!o || !o.values.some((v) => v[0] === value)) throw err(400, 'Unknown option.');
        const all = allOpts();
        all[id] = { ...(all[id] || {}), [key]: value };
        setKv('wall:opts', JSON.stringify(all));
        log(`wall ${id}.${key} -> ${value || 'default'}`);
      }
      return send(res, 200, { scene: scene(), opts: optsFor(b.option ? b.option.scene : scene()) }), true;
    }
    return false;
  }
  return { route, scene, wall: () => ({ scene: scene(), opts: optsFor(scene()) }) };
}
