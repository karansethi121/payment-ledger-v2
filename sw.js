const CACHE_NAME = 'ledger-v2-shell-4';
const SHELL_FILES = [
  './',
  './index.html',
  './assets/style.css',
  './assets/app.js',
  './manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// Network-first for same-origin app-shell files, falling back to cache only
// when offline. (Previously this was cache-first, which meant a code update
// wouldn't actually show up until the load *after* the one that silently
// re-fetched it in the background -- confusing for anyone actively getting
// fixes pushed, and the whole point of the offline cache is resilience with
// no connection, not preferring stale content when the network is fine.)
// Everything cross-origin (Supabase, CDN fonts/scripts) just goes straight to
// the network, untouched, so live data is never cached.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const isSameOrigin = event.request.url.startsWith(self.location.origin);
  if (!isSameOrigin) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
