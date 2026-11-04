/* Family Finance Planner service worker: offline shell + push notifications. */

// Bumped when the shell contract changes: activation deletes every older cache,
// so a phone that kept the previous build cannot serve stale HTML or bundles.
const CACHE = 'ffp-shell-v2';
const SHELL = ['/', '/index.html', '/manifest.json', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL).catch(() => undefined)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put('/index.html', copy)).catch(() => undefined);
          return res;
        })
        .catch(() => caches.match('/index.html').then((hit) => hit || Response.error())),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) return hit;
      return fetch(request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => undefined);
        }
        return res;
      });
    }),
  );
});

// The profile the user is currently looking at, so a notification for a
// different profile can stay generic instead of putting another profile's
// amounts on a lock screen.
let activeProfile = '';
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'profile' && typeof data.id === 'string') activeProfile = data.id;
});

self.addEventListener('push', (event) => {
  let payload = { title: 'Family Finance Planner', body: 'You have a new alert.' };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch {
    if (event.data) payload.body = event.data.text();
  }
  const otherProfile = payload.profile && activeProfile && payload.profile !== activeProfile;
  const title = payload.title;
  const body = otherProfile
    ? `New ${payload.level === 'high' ? 'urgent ' : ''}update in ${
        String(payload.profileName || 'another profile')
      }`
    : payload.body;
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: payload.tag || 'planner',
      renotify: true,
      data: { url: payload.url || '/', profile: payload.profile || '' },
      vibrate: payload.level === 'high' ? [180, 80, 180] : [120],
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (client.url.includes(self.location.origin)) {
          client.focus();
          return client.navigate(target).catch(() => undefined);
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
