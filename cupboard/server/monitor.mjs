// Monitor: which scene the S20's monitor wall shows, and each scene's options (picked in Cupboard → Settings → Monitor).
export const SCENES = [
  { id: 'mission', label: 'Mission Control', emoji: '🛰️' },
  { id: 'sky', label: 'Live sky', emoji: '🌌' },
  { id: 'flights', label: 'Flight radar', emoji: '✈️' },
  { id: 'wifi', label: 'Wi-Fi devices', emoji: '📶' },
  { id: 'pet', label: 'Life-pet', emoji: '🐾' },
  { id: 'lofi', label: 'Lofi room', emoji: '🎧' },
  { id: 'cams', label: 'Live cams', emoji: '📹' },
  { id: 'pm', label: 'PM study wall', emoji: '📚' },
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
  lofi: [
    { key: 't', label: 'Time of day', values: [['', 'Live'], ['day', 'Day'], ['dusk', 'Dusk'], ['night', 'Night']] },
    { key: 'w', label: 'Weather', values: [['', 'Live'], ['clear', 'Clear'], ['rain', 'Rain'], ['snow', 'Snow']] },
    { key: 'screen', label: 'Monitor shows', values: [['', 'Agent browser'], ['code', 'Scrolling code']] },
  ],
  cams: [
    { key: 'cam', label: 'Camera', values: [['', 'Auto-rotate'], ['bears', 'Bears'], ['iss', 'Earth from the ISS'], ['aurora', 'Northern lights'], ['safari', 'Safari'], ['tokyo', 'Tokyo Bay'], ['aviary', 'Aviary'], ['miami', 'Miami'], ['gwb', 'NYC bridge'], ['fuji', 'Mount Fuji']] },
    { key: 'every', label: 'Switch every', values: [['10', '10 min'], ['5', '5 min'], ['20', '20 min'], ['60', '1 hour']] },
  ],
  pm: [
    { key: 'show', label: 'Show', values: [['', 'All three panels'], ['hn', 'Hacker News only'], ['q', 'Interview question only'], ['fw', 'Frameworks only']] },
  ],
  sky: [
    { key: 'labels', label: 'Labels', values: [['', 'On'], ['0', 'Off']] },
    { key: 'demo', label: 'Time', values: [['', 'Now'], ['iss', 'Next ISS pass']] },
  ],
};

export function install({ readJson, send, err, getKv, setKv, log }) {
  const scene = () => getKv('wall:scene', 'mission');
  const allOpts = () => { try { return JSON.parse(getKv('wall:opts', '{}')) || {}; } catch { return {}; } };
  // Only values from OPTIONS, and only non-default ones, so the scene URL stays short.
  const optsFor = (id) => {
    const set = allOpts()[id] || {}, out = {};
    for (const o of OPTIONS[id] || []) if (set[o.key] != null && set[o.key] !== o.values[0][0] && o.values.some((v) => v[0] === set[o.key])) out[o.key] = set[o.key];
    return out;
  };

  async function route(req, res, path, query, me) {
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
