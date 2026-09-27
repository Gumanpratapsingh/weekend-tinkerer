// Read-only view of the room watcher (phone-server/room/roomwatch.mjs) for the hub, plus arm/disarm.
// The watcher owns the data; this module only reads ~/room and sends the same ntfy control commands.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { HOME, TOPIC } from '../core.mjs';

const ROOM = join(HOME, 'room');

function events(limit) {
  const f = join(ROOM, 'events.jsonl');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').trim().split('\n').slice(-limit).reverse()
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

export default {
  routes: {
    'GET /api/room': () => {
      const f = join(ROOM, 'state.json');
      return { state: existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null, events: events(100) };
    },
    'POST /api/room/arm': async ({ body }) => {
      const cmd = body.armed ? 'arm' : 'disarm';
      await fetch(`https://ntfy.sh/${TOPIC}-ctl`, { method: 'POST', body: cmd });
      return { sent: cmd };
    },
  },
};
