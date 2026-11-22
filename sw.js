// Service Worker: hält die App-Dateien offline verfügbar. Sync- und API-Aufrufe gehen immer ins Netz.
// Bei jeder Änderung an den App-Dateien VERSION erhöhen (und APP_VERSION in app.js) – sonst bleiben Geräte auf dem alten Stand.
const VERSION = '8';
const CACHE = 'zeiterfassung-v' + VERSION;
const DATEIEN = ['./', 'index.html', 'app.js', 'style.css', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  // cache: 'reload' umgeht den HTTP-Cache (GitHub Pages: max-age=600), sonst landen alte Dateien im neuen Cache
  e.waitUntil(caches.open(CACHE)
    .then(c => c.addAll(DATEIEN.map(u => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/sync/')) return;
  // Stale-while-revalidate: sofort aus dem Cache, im Hintergrund am HTTP-Cache vorbei aktualisieren
  e.respondWith(caches.open(CACHE).then(async cache => {
    const key = e.request.mode === 'navigate' ? 'index.html' : e.request;
    const cached = await cache.match(key, { ignoreSearch: true });
    const netz = fetch(e.request.url, { cache: 'no-cache' }).then(r => {
      if (r.ok) cache.put(key, r.clone());
      return r;
    }).catch(() => cached);
    return cached || netz;
  }));
});
