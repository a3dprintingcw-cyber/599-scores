/* Kòrsou Futbòl — offline cache */
const CACHE = 'korsou-futbol-v1';
const ASSETS = [
  './', './index.html', './manifest.webmanifest', './data.json',
  './icon-48.png','./icon-72.png','./icon-96.png','./icon-144.png','./icon-180.png',
  './icon-192.png','./icon-256.png','./icon-384.png','./icon-512.png','./icon-maskable-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* Network first for the page so updates land, cache fallback so it works offline. */
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  /* Always try the network for the data file so new results arrive, cache as a fallback. */
  if (url.pathname.endsWith('/data.json')) {
    e.respondWith(
      fetch(req).then(r => { const c = r.clone(); caches.open(CACHE).then(x => x.put(req, c)); return r; })
        .catch(() => caches.match(req))
    );
    return;
  }
  const isPage = req.mode === 'navigate' || (req.destination === 'document');
  if (isPage) {
    e.respondWith(
      fetch(req).then(r => {
        const copy = r.clone();
        caches.open(CACHE).then(c => c.put('./index.html', copy));
        return r;
      }).catch(() => caches.match('./index.html'))
    );
    return;
  }
  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(r => {
      const copy = r.clone();
      caches.open(CACHE).then(c => c.put(req, copy));
      return r;
    }).catch(() => hit))
  );
});
