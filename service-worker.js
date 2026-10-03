/* =====================================================================
 *  SMART LIGHT TECHNOLOGY — Service Worker
 *  SERUSOFT TECHNOLOGIES · Sserunkuma Joel
 * ---------------------------------------------------------------------
 *  Purpose:
 *   - Cache the app shell (HTML / CSS / JS / icons) so the app opens
 *     instantly and works even without internet.
 *   - The Smart Light system does NOT depend on the cloud for basic
 *     control (spec §40). The cache is only for the UI shell.
 * =====================================================================
 */

const CACHE_NAME  = 'smartlight-shell-v1.2.0';

/* Files that make up the app shell. Bump CACHE_NAME when any changes. */
const SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/app.js',
  './assets/icon-192.png.png',
  './assets/icon-512.png.png',
  './assets/icon-maskable-512.png.png',
  './assets/apple-touch-icon.png.png',
  './assets/favicon-32.png.png',
  './assets/logo.png',
  './assets/Joel.png',
  './assets/joel2.png'
];

/* ---------------------------------------------------------------------
 *  INSTALL — pre-cache the shell
 * ------------------------------------------------------------------- */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
      .catch((err) => {
        console.warn('[SW] Pre-cache failed:', err);
      })
  );
});

/* ---------------------------------------------------------------------
 *  ACTIVATE — clean up old caches
 * ------------------------------------------------------------------- */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

/* ---------------------------------------------------------------------
 *  FETCH — cache-first for shell, network-fallback for everything else
 * ------------------------------------------------------------------- */
self.addEventListener('fetch', (event) => {
  const req = event.request;

  /* Only handle GET requests */
  if (req.method !== 'GET') return;

  /* Skip cross-origin requests (e.g. future cloud features) */
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;

      return fetch(req)
        .then((res) => {
          /* Cache a copy of same-origin static assets on the fly */
          if (res && res.status === 200 && res.type === 'basic') {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return res;
        })
        .catch(() => {
          /* Offline fallback → serve the app shell for navigation requests */
          if (req.mode === 'navigate') {
            return caches.match('./index.html');
          }
        });
    })
  );
});

/* ---------------------------------------------------------------------
 *  MESSAGE — allow the page to trigger a skipWaiting update
 * ------------------------------------------------------------------- */
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});