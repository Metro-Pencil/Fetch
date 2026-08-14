// Room Logger PWA service worker.
//
// Scope is deliberately narrow: this only ever caches the app shell (this
// page, manifest.json, the icons) and the pinned-version CDN libraries the
// page loads (Chart.js, Hammer.js, the zoom plugin, Google Fonts) -- all
// four CDN URLs already have exact version numbers baked into their paths,
// so caching them can never end up serving a stale version against a newer
// page.
//
// It NEVER caches live data. Every readings.json / status.json request goes
// to *.firebaseio.com -- a different origin from wherever this file itself
// is hosted -- and every link to the ESP32 device (/update, /sync-code) is
// its own separate origin too. Both, along with any non-GET request, are
// passed straight to the network untouched, every single time. Sensor-data
// staleness is the app's own concern (see the "stale" connection state in
// index.html); a service worker getting in the way of that would be
// actively harmful, not helpful.

const SHELL_CACHE = 'room-logger-shell-v1';
const RUNTIME_CACHE = 'room-logger-runtime-v1';

// Known-path assets precached at install time. The HTML page itself is
// deliberately NOT listed here -- its exact deployed filename/path isn't
// known ahead of time, so it's cached opportunistically the first time it's
// actually requested (see the same-origin branch in the fetch handler
// below) rather than guessed at install.
const PRECACHE_ASSETS = [
  'manifest.json',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
  'apple-touch-icon.png',
  'favicon-48.png',
];

// Third-party hosts this page loads scripts/fonts from, by exact version --
// safe to cache aggressively since a version bump means a new URL, not a
// changed response at the same URL.
const RUNTIME_HOSTS = new Set([
  'cdnjs.cloudflare.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
]);

// Anything to these hosts, or these exact ESP32 device paths, is live data
// or a device control action -- never intercepted, never cached.
const NEVER_CACHE_PATHS = new Set(['/update', '/sync-code', '/status.json', '/readings.json']);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(PRECACHE_ASSETS))
      .then(() => self.skipWaiting())
      .catch((err) => console.warn('sw: precache failed (non-fatal):', err))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names
          .filter((name) => name !== SHELL_CACHE && name !== RUNTIME_CACHE)
          .map((name) => caches.delete(name))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // never touch writes -- not that this app makes any cross-origin ones

  const url = new URL(req.url);

  if (url.hostname.endsWith('firebaseio.com')) return;         // live readings/status -- always network
  if (NEVER_CACHE_PATHS.has(url.pathname)) return;              // ESP32 device pages -- always network

  if (url.origin === self.location.origin) {
    // App shell: respond from cache immediately if present (works offline,
    // no network round-trip), while always kicking off a network refresh in
    // the background to keep the cache current for next time. First-ever
    // load falls through to network since there's nothing cached yet.
    event.respondWith(
      caches.open(SHELL_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        const refresh = fetch(req)
          .then((res) => {
            if (res.ok) cache.put(req, res.clone());
            return res;
          })
          .catch(() => null);
        return cached || (await refresh) || Response.error();
      })
    );
    return;
  }

  if (RUNTIME_HOSTS.has(url.hostname)) {
    // Pinned-version CDN assets: cache-first, since the URL itself already
    // guarantees the content can't change under us.
    event.respondWith(
      caches.open(RUNTIME_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) return cached;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      })
    );
    return;
  }

  // Anything else: leave it alone, no caching, no interception.
});
