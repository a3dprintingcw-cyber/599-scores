/* 599 Scores — offline cache. App shell only, never the API. */
const CACHE = '599-scores-v6';
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
  /* Never touch anything that is not this app. The live API in particular must
     always hit the network, or a cached empty response freezes the scores. */
  if (url.origin !== self.location.origin) return;
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
    /* Always revalidate the page against the network, or a phone keeps running
       a build that was replaced on the server hours ago.
       Note: fetch(req, {...}) is illegal for a navigation request, it throws
       "Cannot construct a Request with a Request whose mode is navigate", which
       would send every page load into the cache fallback below. Fetch the URL
       as a fresh request instead. */
    e.respondWith(
      fetch(req.url, { cache: 'reload', credentials: 'same-origin' }).then(r => {
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

/* Tapping a notification should land you in the app, not open a second copy. */
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const want = (e.notification.data && e.notification.data.u) || './';
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.startsWith(self.location.origin)) { await c.focus(); return }
    }
    await self.clients.openWindow(want);
  })());
});

/* Room for real push later: a push arrives here even with the app closed.
   Nothing subscribes yet, so this never fires today. */
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {} } catch (err) { d = { title: '599 Scores', body: e.data ? e.data.text() : '' } }
  const title = d.title || '599 Scores';
  e.waitUntil(self.registration.showNotification(title, {
    body: d.body || '', tag: d.tag || 'push', icon: './icon-192.png', badge: './icon-96.png',
    data: { u: d.url || './' }
  }));
});
