// Offline support. Bump CACHE on every release, or users keep seeing the saved copy.
const CACHE = 'tidy-v3';
const ASSETS = [
  './', 'index.html', 'manifest.webmanifest',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
  'src/tokens.css', 'src/styles.css', 'src/main.js', 'src/stage.js', 'src/pipeline.js',
  'src/worker-client.js', 'src/inpaint.worker.js', 'src/inpaint-core.js', 'src/inpaint-patch.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).catch(() => caches.match('index.html'))),
  );
});
