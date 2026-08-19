const CACHE_PREFIX = 'Japanese-PWA-';
const CACHE_NAME = 'Japanese-PWA-V1_1_1';
const APP_SHELL = [
  './',
  './index.html',
  './style.css?v=V1_1_1',
  './app.js?v=V1_1_1',
  './manifest.json?v=V1_1_1',
  './version.json',
  './storage.js?v=V1_1_1',
  './backup-schema.js?v=V1_1_1',
  './study-streak.js?v=V1_1_1',
  './japanese-learning.js?v=V1_1_1',
  './kana-data.js?v=V1_1_1',
  './kana-strokes.js?v=V1_1_1',
  './handwriting-engine.js?v=V1_1_1',
  './version-manager.js?v=V1_1_1',
  './chart-renderer.js?v=V1_1_1',
  './push-config.js?v=V1_1_1',
  './reminder-manager.js?v=V1_1_1',
  './jszip.min.js?v=3_10_1',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const freshRequests = APP_SHELL.map(url => new Request(new URL(url, self.location.href), { cache: 'reload' }));
    await cache.addAll(freshRequests);
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
        .map(key => caches.delete(key))
    );
    await self.clients.claim();
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    clients.forEach(client => client.postMessage({ type: 'SW_ACTIVATED', version: CACHE_NAME }));
  })());
});

async function networkFirst(request, fallbackUrl) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(new Request(request, { cache: 'no-store' }));
    if (response?.ok) {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch {
    return (await cache.match(request)) || (fallbackUrl ? await cache.match(fallbackUrl) : Response.error());
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(new Request(request, { cache: 'no-store' }));
  if (response?.ok) {
    cache.put(request, response.clone()).catch(() => {});
  }
  return response;
}

self.addEventListener('push', event => {
  let payload = {};
  try { payload = event.data?.json() || {}; }
  catch {
    try { payload = { title: '日本語練習時間到了', options: { body: event.data?.text() || '' } }; }
    catch { payload = {}; }
  }

  const declarative = payload.notification || {};
  const title = payload.title || declarative.title || '日本語練習時間到了';
  const options = payload.options || {
    body: declarative.body || '每天複習一點點，保持日文學習節奏！',
    icon: declarative.icon,
    badge: declarative.badge,
    tag: declarative.tag || 'japanese-daily-reminder',
    data: declarative.data || payload.data || { url: './' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  let targetUrl;
  try { targetUrl = new URL(event.notification.data?.url || './', self.location.href).href; }
  catch { targetUrl = new URL('./', self.location.href).href; }

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin !== new URL(targetUrl).origin) continue;
      try { await client.navigate(targetUrl); } catch {}
      return client.focus();
    }
    return self.clients.openWindow ? self.clients.openWindow(targetUrl) : undefined;
  })());
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.endsWith('/version.json')) {
    event.respondWith(fetch(event.request, { cache: 'no-store' }).catch(async () => {
      const cache = await caches.open(CACHE_NAME);
      return (await cache.match(new URL('./version.json', self.location.href).href)) || Response.error();
    }));
    return;
  }

  // Deployment-specific Worker URL may be filled in after the first GitHub
  // Pages release. Always prefer the network so that change does not require
  // another app version bump, while keeping the cached copy for offline use.
  if (url.pathname.endsWith('/push-config.js')) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  if (event.request.mode === 'navigate') {
    event.respondWith(networkFirst(event.request, './index.html'));
    return;
  }

  const isStatic = /\.(?:js|css|json|png|svg|webp|ico)$/i.test(url.pathname);
  event.respondWith(isStatic ? cacheFirst(event.request) : networkFirst(event.request));
});
