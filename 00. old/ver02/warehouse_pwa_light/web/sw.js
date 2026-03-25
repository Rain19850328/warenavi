// sw.js — cache assets; ignore /api
const CACHE = 'warehouse-pwa-classic-glow-v1755585017';
const ASSETS = [
  '/web/',
  '/web/index.html',
  '/web/style.css',
  '/web/app.js',
  '/web/manifest.webmanifest',
  '/web/icons/icon-192.png',
  '/web/icons/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k!==CACHE).map(k => caches.delete(k)))));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/')) return;
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).then(res => {
      const resClone = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, resClone));
      return res;
    }))
  );
});
