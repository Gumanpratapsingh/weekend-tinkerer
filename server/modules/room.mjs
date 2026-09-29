// Read-only view of the room watcher (phone-server/room/roomwatch.mjs) for the hub, plus arm/disarm.
// The watcher owns the data; this module only reads ~/room and sends the same ntfy control commands.
import { readFileSync, existsSync, watchFile } from 'node:fs';
import { join } from 'node:path';
import { HOME, TOPIC } from '../core.mjs';

const ROOM = join(HOME, 'room');

function events(limit) {
  const f = join(ROOM, 'events.jsonl');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').trim().split('\n').slice(-limit).reverse()
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

const readState = () => { const f = join(ROOM, 'state.json'); try { return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null; } catch { return null; } };

// Live updates over Server-Sent Events: the watcher rewrites state.json on every change (and the light
// level every few seconds), so poll its mtime once a second and push the new state to open pages.
const clients = new Set();
let watching = false;
function broadcast() {
  const frame = `event: room\ndata: ${JSON.stringify({ ...readState(), events: events(100) })}\n\n`;
  for (const res of clients) res.write(frame);
}
export function stream(req, res) {
  if (clients.size >= 10) return res.writeHead(503).end();
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
  res.write('retry: 3000\n\n');
  clients.add(res);
  res.write(`event: room\ndata: ${JSON.stringify({ ...readState(), events: events(100) })}\n\n`);
  const ping = setInterval(() => res.write(': ping\n\n'), 20e3);   // keeps nginx and Cloudflare from closing it
  req.on('close', () => { clearInterval(ping); clients.delete(res); });
  if (!watching) { watching = true; watchFile(join(ROOM, 'state.json'), { interval: 1000 }, () => { if (clients.size) broadcast(); }); }
}

export default {
  routes: {
    'GET /api/room': () => {
      return { state: readState(), events: events(100) };
    },
    'POST /api/room/arm': async ({ body }) => {
      const cmd = body.armed ? 'arm' : 'disarm';
      await fetch(`https://ntfy.sh/${TOPIC}-ctl`, { method: 'POST', body: cmd });
      return { sent: cmd };
    },
  },
};
