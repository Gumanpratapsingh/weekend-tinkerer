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
    if (path === '/api/wall' && req.method === 'GET') return send(res, 200, { scene: scene(), scenes: SCENES, canSet: me.role === 'owner' }), true;
    if (path === '/api/wall' && req.method === 'POST') {
      if (me.role !== 'owner') throw err(403, 'Only the owner can change the monitor.');
      const id = String((await readJson(req, 200)).scene || '');
      if (!SCENES.some((s) => s.id === id)) throw err(400, 'Unknown scene.');
      setKv('wall:scene', id);
      log(`wall scene -> ${id}`);
      return send(res, 200, { scene: id }), true;
    }
    return false;
  }
  return { route, scene };
}
