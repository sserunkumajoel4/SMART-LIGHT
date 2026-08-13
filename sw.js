// Service Worker for Mutanda Traders Admin
const CACHE_NAME = 'smartlight-v2.0.29';
const urlsToCache = [
  './',
  './index.html',
  './manifest.json',
  './audio/60%20(1).mp3',
  './icons/ICON%2072.png',
  './icons/ICON%2096.png',
  './icons/ICON%20128.png',
  './icons/ICON%20144.png',
  './icons/ICON%20152.png',
  './icons/ICON%20192.png',
  './icons/ICON%20384.png',
  './icons/ICON%20512.png'
];

// Install event
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Caching files...');
        return cache.addAll(urlsToCache);
      })
  );
});

// Activate event
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(cacheNames
        .filter(cacheName => cacheName !== CACHE_NAME)
        .map(cacheName => {
          console.log('Deleting old cache:', cacheName);
          return caches.delete(cacheName);
        })
      );
    }).then(() => {
      console.log('Service worker activated');
      return self.clients.claim();
    })
  );
});

// Fetch event
self.addEventListener('fetch', event => {
  // For navigation requests (the HTML page), use a network-first strategy.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          // If the fetch is successful, cache the new response.
          return caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, response.clone());
            return response;
          });
        })
        .catch(() => {
          // If the network fails, serve the cached page.
          return caches.match(event.request);
        })
    );
  } else {
    // For all other requests (CSS, images, audio), use a cache-first strategy.
    event.respondWith(
      caches.match(event.request).then(response => {
        return response || fetch(event.request);
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

// Message handling
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});show old channgees instead of the new ones
