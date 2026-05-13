// ============================================================
//  CDRRMO FEWS — Service Worker
//  Cache-first for static assets, network-first for API calls
// ============================================================

const CACHE_NAME = 'cdrrmo-fews-v1';

// Static assets to pre-cache on install
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/cdrrmo-seal.png',
  '/batscity-seal.png',
  '/leaflet/marker-icon.png',
  '/leaflet/marker-icon-2x.png',
  '/leaflet/marker-shadow.png',
];

// ── Install: pre-cache shell assets ──────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Pre-caching assets');
      return cache.addAll(PRECACHE_ASSETS);
    })
  );
  self.skipWaiting();
});

// ── Activate: remove old caches ───────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => {
            console.log('[SW] Deleting old cache:', key);
            return caches.delete(key);
          })
      )
    )
  );
  self.clients.claim();
});

// ── Fetch: network-first for API, cache-first for static ──────
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Always go network-first for API calls (sensor data, logs, etc.)
  if (url.origin === 'https://cdrrmo-fews.onrender.com') {
    event.respondWith(
      fetch(event.request)
        .catch(() => {
          // API offline — return a friendly JSON error
          return new Response(
            JSON.stringify({ error: 'offline', message: 'No network connection. Please reconnect.' }),
            { status: 503, headers: { 'Content-Type': 'application/json' } }
          );
        })
    );
    return;
  }

  // Skip non-GET requests
  if (event.request.method !== 'GET') return;

  // Cache-first for everything else (JS, CSS, images, fonts)
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;

      return fetch(event.request)
        .then((response) => {
          // Only cache valid same-origin or CDN responses
          if (
            !response ||
            response.status !== 200 ||
            (response.type !== 'basic' && response.type !== 'cors')
          ) {
            return response;
          }

          const toCache = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, toCache);
          });

          return response;
        })
        .catch(() => {
          // Offline and not cached — return the cached index for navigation
          if (event.request.mode === 'navigate') {
            return caches.match('/index.html');
          }
        });
    })
  );
});

// ── Push Notifications (future use) ───────────────────────────
self.addEventListener('push', (event) => {
  if (!event.data) return;
  const data = event.data.json();
  self.registration.showNotification(data.title || 'CDRRMO FEWS Alert', {
    body:    data.body    || 'New alert from FEWS station.',
    icon:    '/cdrrmo-seal.png',
    badge:   '/cdrrmo-seal.png',
    tag:     'fews-alert',
    requireInteraction: true,
  });
});