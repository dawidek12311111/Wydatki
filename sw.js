// Service worker: pozwala uruchomić aplikację bez internetu.
// Przy każdej zmianie plików aplikacji zwiększ VERSION — telefon pobierze nową wersję.
const VERSION = 'sf-v0.2.1';
const FILES = [
  './', './index.html', './manifest.webmanifest', './style.css',
  './app.js', './db.js', './calc.js', './money.js', './dates.js',
  './parse.js', './validate.js', './csv.js', './defaults.js',
  './icon-192.png', './icon-512.png', './icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Najpierw sieć (świeża wersja), bez sieci — kopia z pamięci.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('./index.html'))),
  );
});
