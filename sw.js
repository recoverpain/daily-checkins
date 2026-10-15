// Offline support: the app files are cached on first visit, so the app opens without a connection.
// Bump VERSION (and the ?v= on styles.css and app.js in index.html) whenever a file changes.
const VERSION = 'checkins-v5';
const FILES = [
  './', 'index.html', 'styles.css?v=4', 'app.js?v=4', 'merge.js', 'manifest.webmanifest',
  'vendor/mediabunny.min.mjs', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Network first, so updates arrive when online; the cache answers when offline.
// 'no-cache' makes the browser check with the server every time, so a page never mixes new and old files.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request.url, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html'))),
  );
});
