// ============================================================
//  CDRRMO FEWS — Service Worker v2
//  - Cache-first for static assets
//  - Network-first for API calls
//  - Auto-reload on new deploy (no manual re-add needed)
// ============================================================

const CACHE_NAME = 'cdrrmo-fews-BUILD_STAMP';

// Only truly stable assets that never change filename.
// JS/CSS bundles are excluded — Vite hashes their filenames
// so they're always fresh from the network anyway.
const PRECACHE_ASSETS = [
  '/cdrrmo-seal.png',
  '/batscity-seal.png',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-apple-180.png',
  '/leaflet/marker-icon.png',
  '/leaflet/marker-icon-2x.png',
  '/leaflet/marker-shadow.png',
];

// ── Install ───────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  // skipWaiting OUTSIDE waitUntil — runs unconditionally even
  // if cache.addAll() fails, so updates are never blocked.
  self.skipWaiting();

  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // addAll with individual error handling — one missing asset
      // won't abort the entire install.
      return Promise.allSettled(
        PRECACHE_ASSETS.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('[SW] Failed to pre-cache:', url, err);
          })
        )
      );
    })
  );
});

// ── Activate: delete old caches, claim clients, notify tabs ──
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => {
              console.log('[SW] Deleting old cache:', key);
              return caches.delete(key);
            })
        )
      )
      .then(() => self.clients.claim())
  );
});

// ── Fetch ─────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Network-first for all API calls — never serve stale sensor data
  if (url.origin === 'https://cdrrmo-fews.onrender.com') {
    event.respondWith(
      fetch(event.request).catch(() =>
        new Response(
          JSON.stringify({ error: 'offline', message: 'No network connection.' }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        )
      )
    );
    return;
  }

  // Skip non-GET (POST /logs, POST /siren, etc. must always hit network)
  if (event.request.method !== 'GET') return;

  // Cache-first for static assets (images, fonts, leaflet, etc.)
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;

      return fetch(event.request)
        .then((response) => {
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
          // Offline fallback for navigation requests
          if (event.request.mode === 'navigate') {
            return caches.match('/index.html');
          }
        });
    })
  );
});

// ── Skip Waiting (triggered by app on new deploy detected) ──────────────────
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ── Push Notifications ──────────────────────────────────────────────────────
self.addEventListener('push', (event) => {
  if (!event.data) return;
  const data = event.data.json();
  event.waitUntil(
    self.registration.showNotification(data.title || 'CDRRMO FEWS Alert', {
      body:               data.body || 'New alert from FEWS station.',
      icon:               '/icon-192.png',
      badge:              '/icon-192.png',
      tag:                'fews-alert',
      requireInteraction: false,
      vibrate:            [200, 100, 200],
    }).then(() => new Promise((resolve) => {
      setTimeout(() => {
        self.registration.getNotifications({ tag: 'fews-alert' })
          .then((notifs) => { notifs.forEach((n) => n.close()); resolve(); });
      }, 30000);
    }))
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.openWindow('https://cdrrmo-fews.vercel.app/')
  );
});