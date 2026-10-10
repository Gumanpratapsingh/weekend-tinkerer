// Cupboard service worker: shows push notifications, opens the right chat on tap, and keeps a copy of the
// app shell so the app still opens (with an error message) when the phone server is unreachable.
const SHELL = 'cupboard-shell-v1';

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(SHELL).then((c) => c.add(new Request('/', { cache: 'reload' }))).catch(() => {}));
});
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});

// Pages: network first, the cached shell when offline. Everything else (API, assets) goes straight to the network.
self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request).catch(async () => (await caches.match('/')) || Response.error()));
});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data?.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Cupboard', {
    body: d.body || '', tag: d.tag, renotify: !!d.tag, icon: '/icons/icon-192.png', badge: '/icons/badge-72.png',
    data: { url: d.url || '/' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).origin === self.location.origin) {
        await w.focus();
        w.postMessage({ nav: url });
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
