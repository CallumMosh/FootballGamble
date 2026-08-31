// HitRate service worker — exists only to satisfy PWA installability (Chrome
// requires a registered service worker with a fetch handler before it will
// offer "Install app"). Deliberately does NOT cache anything: this site's
// whole value is showing real, current numbers — caching a page shell or an
// API response could silently show someone a stale percentage or an old
// fixture, which cuts against the entire point of the site. Every request
// just passes straight through to the network, untouched.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
