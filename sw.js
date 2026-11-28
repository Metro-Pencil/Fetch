// Room Logger PWA service worker (v3.9.5).
//
// Precaches the app shell, optimized pre-blurred backdrop, and pinned-version
// CDN libraries (Chart.js, Hammer.js, zoom plugin) at install time so the PWA
// boots immediately from cache with zero render-blocking CDN stalls.
//
// It NEVER caches live data (*.firebaseio.com, ESP32 device paths, OTA .bin,
// or app-version.json).

const SHELL_CACHE = 'room-logger-shell-v35';
const RUNTIME_CACHE = 'room-logger-runtime-v2';

const PRECACHE_ASSETS = [
  './',
  'index.html',
  'manifest.json',
  'bg-backdrop.jpg',
  'base.css?v=3.12.0',
  'themes.css?v=3.12.0',
  'ui.js?v=3.12.0',
  'data.js?v=3.12.0',
  'cloud.js?v=3.12.0',
  'charts.js?v=3.12.0',
  'analytics.js?v=3.12.0',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
  'apple-touch-icon.png',
  'favicon-48.png',
];

const PRECACHE_CDN_ASSETS = [
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/hammer.js/2.0.8/hammer.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/chartjs-plugin-zoom/2.2.0/chartjs-plugin-zoom.min.js',
];

const RUNTIME_HOSTS = new Set([
  'cdnjs.cloudflare.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
]);

const NEVER_CACHE_PATHS = new Set([
  '/wifi', '/firebase', '/credentials', '/power-saving', '/health',
  '/telemetry', '/telemetry-data', '/update', '/update-url',
  '/status.json', '/readings.json',
]);

self.addEventListener('install', (event) => {
  event.waitUntil(
    Promise.all([
      caches.open(SHELL_CACHE).then((cache) =>
        Promise.allSettled(PRECACHE_ASSETS.map((url) => cache.add(url)))
      ),
      caches.open(RUNTIME_CACHE).then((cache) =>
        Promise.allSettled(PRECACHE_CDN_ASSETS.map((url) => cache.add(url)))
      ),
    ])
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
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  if (url.hostname.endsWith('firebaseio.com')) return;
  if (NEVER_CACHE_PATHS.has(url.pathname)) return;
  if (url.pathname.includes('/firmware/')) return;
  if (url.pathname.endsWith('/app-version.json')) return;

  if (url.origin === self.location.origin) {
    // Stale-while-revalidate with event.waitUntil() so background refresh
    // always finishes caching even when responding immediately from cache.
    event.respondWith(
      caches.open(SHELL_CACHE).then(async (cache) => {
        const cached = await cache.match(req, { ignoreSearch: true });
        const refresh = fetch(req, { cache: 'no-cache' })
          .then((res) => {
            if (res && res.ok) {
              return cache.put(req, res.clone()).then(() => res);
            }
            return res;
          })
          .catch(() => null);
        if (cached) {
          event.waitUntil(refresh);
          return cached;
        }
        return (await refresh) || Response.error();
      })
    );
    return;
  }

  if (RUNTIME_HOSTS.has(url.hostname)) {
    // Pinned-version CDN & Google Fonts: cache-first with safe offline fallback.
    event.respondWith(
      caches.open(RUNTIME_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) return cached;
        try {
          const res = await fetch(req);
          if (res && (res.ok || res.type === 'opaque')) {
            event.waitUntil(cache.put(req, res.clone()));
          }
          return res;
        } catch (err) {
          return Response.error();
        }
      })
    );
    return;
  }
});
