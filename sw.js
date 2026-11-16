// Keeps the whole app and its timetables on the phone, so it opens with no signal.
// App files: one cache per release (change VERSION when any of them change).
// Timetables (data/): served from the saved copy at once, refreshed in the background.
const VERSION = '0.1.0';
const CACHE = `ssi-${VERSION}`;
const DATA = 'ssi-data';
const FILES = [
  './', 'index.html', 'style.css', 'manifest.webmanifest',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
  'js/app.js', 'js/bus.js', 'js/days.js', 'js/ferry.js', 'js/map.js', 'js/util.js',
];
const DATA_FILES = ['data/bus.json', 'data/ferries.json', 'data/map.json'];

self.addEventListener('install', e => {
  e.waitUntil(Promise.all([
    caches.open(CACHE).then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' })))),
    caches.open(DATA).then(c => c.addAll(DATA_FILES.map(f => new Request(f, { cache: 'reload' })))),
  ]).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('ssi-') && k !== CACHE && k !== DATA).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;   // live ferry API goes straight out
  const path = url.pathname.slice(new URL(self.registration.scope).pathname.length);
  if (path.startsWith('data/')) {
    e.respondWith(caches.open(DATA).then(async c => {
      const key = path.split('?')[0];
      const saved = await c.match(key);
      const fresh = fetch(new Request(key, { cache: 'no-cache' }))
        .then(r => { if (r.ok) c.put(key, r.clone()); return r; })
        .catch(() => null);
      if (saved) { e.waitUntil(fresh); return saved; }
      return (await fresh) || new Response('{}', { status: 503 });
    }));
    return;
  }
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(r => r || fetch(e.request)));
});
