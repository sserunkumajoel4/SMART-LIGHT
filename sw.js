// Service Worker for SmartLight - v2.1
const CACHE_NAME = 'smartlight-v2.1.0';
const urlsToCache = [
  './',
  './index.html',
  './manifest.json',
  './icons/ICON%2072.png',
  './icons/ICON%2096.png',
  './icons/ICON%20128.png',
  './icons/ICON%20144.png',
  './icons/ICON%20152.png',
  './icons/ICON%20192.png',
  './icons/ICON%20384.png',
  './icons/ICON%20512.png'
];

// Install event - force update
self.addEventListener('install', event => {
  console.log('📦 Service Worker v2.1 installing...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('📦 Caching files...');
        return cache.addAll(urlsToCache);
      })
      .then(() => {
        console.log('✅ New Service Worker installed');
        return self.skipWaiting();
      })
  );
});

// Activate event - clear old caches immediately
self.addEventListener('activate', event => {
  console.log('🚀 Service Worker v2.1 activating...');
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            console.log('🗑️ Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
    .then(() => {
      console.log('✅ Old caches cleared');
      return self.clients.claim();
    })
  );
});

// Fetch event - network first, then cache
self.addEventListener('fetch', event => {
  // For navigation requests (HTML page), use network-first
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          // Clone the response and update cache
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, responseClone);
          });
          return response;
        })
        .catch(() => {
          return caches.match(event.request);
        })
    );
  } else {
    // For all other requests, use cache-first then network
    event.respondWith(
      caches.match(event.request)
        .then(response => {
          if (response) {
            return response;
          }
          return fetch(event.request).then(response => {
            // Cache the fetched response
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then(cache => {
              cache.put(event.request, responseClone);
            });
            return response;
          });
        })
    );
  }
});

// Push notifications
self.addEventListener('push', event => {
  const options = {
    body: 'A scheduled event has occurred!',
    icon: './icons/ICON%20192.png',
    badge: './icons/ICON%2096.png',
    vibrate: [100, 50, 100],
    data: {
      url: './',
      timestamp: Date.now()
    }
  };

  event.waitUntil(
    self.registration.showNotification('SmartLight', options)
  );
});

// Notification click
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(windowClients => {
      for (let client of windowClients) {
        if (client.url === event.notification.data.url && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(event.notification.data.url);
      }
    })
  );
});

// Message handling
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

console.log('📱 SmartLight Service Worker v2.1 registered');
