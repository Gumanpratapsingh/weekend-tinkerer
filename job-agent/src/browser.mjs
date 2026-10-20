// Client for the browser worker (browser/worker.mjs, inside the Debian proot on 127.0.0.1:8084).
// Plain node:http, not fetch: fetch gives up after 5 minutes without response headers, and a full Naukri
// search takes ~20 minutes (that silently threw away every search result until 2026-10-10).
import { request } from 'node:http';
import { PERSON, PORT } from './core.mjs';
import { held, holdOff } from './holdoff.mjs';

// Searches on a site that answered "too many requests" are not sent for 12-18 hours (src/holdoff.mjs).
const SEARCH_SITE = { naukri_search: 'naukri.com', naukri_recommended: 'naukri.com' };

export function browserTask(name, body = {}, timeoutMs = 300000) {
  const site = SEARCH_SITE[name];
  if (site && held(site)) return Promise.resolve({ status: 'rate_limited', jobs: [] });
  const payload = JSON.stringify({ ...body, _who: { person: PERSON || 'owner', port: PORT } });   // whose logins and folders to use
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: 8084, path: `/${name}`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        clearTimeout(timer);
        let out; try { out = JSON.parse(raw); } catch { out = { error: `worker ${res.statusCode}` }; }
        if (res.statusCode >= 400) reject(new Error(out.error || `worker ${res.statusCode}`));
        else { if (site && out.status === 'rate_limited') holdOff(site, `${name} got 429`); resolve(out); }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error(`browser task ${name} timed out`)), timeoutMs);
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.end(payload);
  });
}
export const renderPdf = (html, pdf) => browserTask('pdf', { html, pdf }, 120000);
