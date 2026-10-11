// Laptop server dashboard: health of the Dell G3 that runs the job agents (laptop/server.mjs on 127.0.0.1:8095
// there, reached through the job agent's ssh link) and the owner's commands to it. Owner login required.
const API = 'http://127.0.0.1:8095';
const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });
const COMMANDS = ['stop_agents', 'start_agents', 'restart_agents', 'restart_browser', 'reboot', 'shutdown'];
let lastSeen = null;

export default {
  routes: {
    'GET /api/laptop': async () => {
      const r = await fetch(`${API}/health`, { signal: AbortSignal.timeout(8000) }).catch(() => null);
      if (!r?.ok) return { online: false, lastSeen };
      const h = await r.json();
      lastSeen = h.at;
      return { online: true, ...h };
    },

    'POST /api/laptop/command': async ({ body }) => {
      if (!COMMANDS.includes(body.cmd)) throw fail(400, 'Unknown command.');
      const r = await fetch(`${API}/command`, { method: 'POST', body: JSON.stringify({ cmd: body.cmd }), signal: AbortSignal.timeout(40000) }).catch(() => null);
      if (!r) throw fail(503, 'The laptop is not reachable.');
      const out = await r.json().catch(() => ({}));
      if (!r.ok || out.ok === false) throw fail(500, out.error || 'The laptop could not do that.');
      return { ok: true };
    },
  },
};
