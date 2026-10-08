// Client for the browser worker (browser/worker.mjs, inside the Debian proot on 127.0.0.1:8084).
export async function browserTask(name, body = {}, timeoutMs = 300000) {
  const r = await fetch(`http://127.0.0.1:8084/${name}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const out = await r.json().catch(() => ({ error: `worker ${r.status}` }));
  if (!r.ok) throw new Error(out.error || `worker ${r.status}`);
  return out;
}
export const renderPdf = (html, pdf) => browserTask('pdf', { html, pdf }, 120000);
