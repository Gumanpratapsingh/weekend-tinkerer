// Browser worker: runs inside the Debian proot under Xvfb (headed Chromium — Naukri's Akamai blocks headless).
// Listens on 127.0.0.1:8084. The agent (Termux) posts tasks; each site module exports async handlers.
// The jobagent folder is bind-mounted at the same path, so file paths are shared with the agent.
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, getBrowser, touch } from './session.mjs';

// ---------- tasks ----------
const tasks = {
  async ping() { await getBrowser(); return { ok: true, version: (await getBrowser()).version() }; },

  // Diagnostics: open a URL with a site's session, report what loaded, save a screenshot.
  async probe({ url, site = 'probe' }) {
    const { siteContext, shotPath } = await import('./session.mjs');
    const ctx = await siteContext(site);
    const page = await ctx.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(4000);
      const shot = shotPath(`probe-${site}`);
      await page.screenshot({ path: shot });
      return { url: page.url(), title: await page.title(), text: (await page.innerText('body')).slice(0, 1500), shot };
    } finally { await ctx.close(); }
  },

  // HTML file -> one-page PDF, shrinking the scale until it fits.
  async pdf({ html, pdf }) {
    const b = await getBrowser();
    const page = await b.newPage();
    try {
      await page.goto(`file://${html}`);
      let scale = 1;
      for (; scale > 0.8; scale -= 0.03) {
        const h = await page.evaluate(() => document.documentElement.scrollHeight);
        // Letter is 11in; minus 0.9in margins = 10.1in = 970 CSS px at 96dpi.
        if (h * scale <= 965) break;
      }
      await page.pdf({ path: pdf, format: 'Letter', printBackground: true, scale: Math.max(scale, 0.8),
        margin: { top: '0.45in', bottom: '0.45in', left: '0.5in', right: '0.5in' } });
      return { ok: true, scale: Number(scale.toFixed(2)) };
    } finally { await page.close(); }
  },
};

// Site modules (naukri, linkedin, ats) add their own tasks.
for (const mod of ['naukri', 'linkedin', 'ats']) {
  const f = join(ROOT, 'browser', `${mod}.mjs`);
  if (existsSync(f)) Object.assign(tasks, (await import(f)).default);
}

let queue = Promise.resolve();                       // one task at a time: the phone has one browser
createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const name = req.url.slice(1);
    const reply = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (!tasks[name]) return reply(404, { error: `no task ${name}` });
    queue = queue.then(async () => {
      try { reply(200, await tasks[name](raw ? JSON.parse(raw) : {})); touch(); }
      catch (e) { console.error(name, e); reply(500, { error: e.message }); }
    });
  });
}).listen(8084, '127.0.0.1', () => console.log('browser worker on 127.0.0.1:8084'));
