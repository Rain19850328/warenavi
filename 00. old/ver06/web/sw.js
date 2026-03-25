// PWA service worker — anti-stale (v20250822-02)
const CACHE_NAME = 'pwa-cache-v20250822-02';

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE_NAME));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/')) {
    if (e.request.method !== 'GET') return;
    e.respondWith((async () => {
      try {
        return await fetch(e.request, { cache:'no-store' });
      } catch (err) {
        const cached = await caches.match(e.request);
        if (cached) return cached;
        throw err;
      }
    })());
    return;
  }
  const isCore = /\/(index\.html|app\.js|style\.css)$/.test(url.pathname);
  if (isCore) {
    e.respondWith((async () => {
      try { return await fetch(e.request, { cache:'no-store' }); }
      catch { return caches.match(e.request); }
    })());
    return;
  }
  e.respondWith((async () => {
    const cached = await caches.match(e.request);
    if (cached) return cached;
    const res = await fetch(e.request);
    try {
      const cache = await caches.open(CACHE_NAME);
      cache.put(e.request, res.clone());
    } catch (err) {}
    return res;
  })());
});