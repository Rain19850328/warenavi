// PWA service worker — anti-stale (v20250822-02)
const CACHE_NAME = 'pwa-cache-v20250822-02';

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE_NAME)); // (Optional) Precache static here if needed
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

// Fetch strategy:
// 1) /api/* : network-first + no-store (GET만), 실패 시 캐시(선택)
// 2) core (index.html/app.js/style.css): network-first + no-store
// 3) others: cache-first
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // (선택) 동일 출처만 처리
  // if (url.origin !== self.location.origin) return;

  // 1) API
  if (url.pathname.startsWith('/api/')) {
    if (e.request.method !== 'GET') return; // POST/PUT/DELETE는 기본 네트워크
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

  // 2) Core
  const isCore = /\/(index\.html|app\.js|style\.css)$/.test(url.pathname);
  if (isCore) {
    e.respondWith((async () => {
      try { return await fetch(e.request, { cache:'no-store' }); }
      catch { return caches.match(e.request); }
    })());
    return;
  }

  // 3) Others: cache-first
  e.respondWith((async () => {
    const cached = await caches.match(e.request);
    if (cached) return cached;
    const res = await fetch(e.request);
    try {
      const cache = await caches.open(CACHE_NAME);
      cache.put(e.request, res.clone());
    } catch (err) {
      // ignore cache put errors
    }
    return res;
  })());
});
