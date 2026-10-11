#!/bin/sh
# Watches both job agents on the laptop: every 2 minutes, what each is doing, attempts since the start
# (by result), the latest application lines, browser lanes and CPU temperature. Usage: sh watch-agents.sh [minutes]
MIN=${1:-30}
T0=$(($(date +%s) * 1000))
END=$(($(date +%s) + MIN * 60))
while [ "$(date +%s)" -lt "$END" ]; do
  ssh -o ConnectTimeout=8 laptop-server "T0=$T0 node --no-warnings -e '
const { DatabaseSync } = require(\"node:sqlite\");
const T0 = Number(process.env.T0), H = process.env.HOME + \"/jobagent\";
const t = (ms) => new Date(ms + 5.5 * 3600e3).toISOString().slice(11, 19);
(async () => {
  const health = await fetch(\"http://127.0.0.1:8084/health\").then((r) => r.json()).catch(() => ({}));
  const lap = await fetch(\"http://127.0.0.1:8095/health\").then((r) => r.json()).catch(() => ({}));
  console.log(\`\\n===== \${t(Date.now())} IST · CPU \${lap.temps?.cpu ?? \"?\"}°C · RAM \${lap.memory ? Math.round(100 - 100 * lap.memory.available / lap.memory.total) : \"?\"}% · browser lanes: \${JSON.stringify(health.lanes || {})} · waiting \${health.waiting ?? \"?\"}\`);
  for (const [who, port, db] of [[\"Guman\", 8083, H + \"/data/agent.db\"], [\"Vertika\", 8093, H + \"/people/vertika/data/agent.db\"]]) {
    const s = await fetch(\`http://127.0.0.1:\${port}/internal/dash/summary\`).then((r) => r.json()).catch(() => null);
    const d = new DatabaseSync(db, { readOnly: true });
    const by = d.prepare(\"SELECT status, count(*) n FROM attempts WHERE at >= ? GROUP BY status\").all(T0).map((r) => \`\${r.status} \${r.n}\`).join(\", \") || \"none yet\";
    const last = d.prepare(\"SELECT a.at, a.status, a.reason, j.title, j.company, j.source FROM attempts a LEFT JOIN jobs j ON j.id = a.job_id WHERE a.at >= ? ORDER BY a.at DESC LIMIT 3\").all(T0);
    console.log(\`\${who}: \${s ? (s.paused ? \"PAUSED\" : \"running\") : \"NOT RESPONDING\"} · now: \${s?.now?.text?.slice(0, 80) || \"?\"}\`);
    console.log(\`   attempts since start: \${by} · applied today: \${s?.today?.applied ?? \"?\"}\`);
    for (const a of last) console.log(\`   \${t(a.at)} \${a.status.padEnd(12)} \${a.source || \"\"} · \${(a.title || \"\").slice(0, 40)} @ \${a.company || \"\"}\${a.reason ? \" · \" + a.reason.slice(0, 60) : \"\"}\`);
  }
})();
'"
  sleep 120
done
echo "watch finished"
