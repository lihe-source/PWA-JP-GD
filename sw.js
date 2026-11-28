const CACHE_PREFIX = 'Japanese-PWA-';
const CACHE_NAME = 'Japanese-PWA-V1_6_3';
const APP_SHELL = [
  './similar-kana.js?v=V1_6_3',
  './cloud-runtime.js?v=V1_6_3',
  './collection-store.js?v=V1_6_3',
  './settings-vault.js?v=V1_6_3',
  './interaction-runtime.js?v=V1_6_3',
  './gemini-client.js?v=V1_6_3',
  './ui-runtime.js?v=V1_6_3',
  './background-jobs.js?v=V1_6_3',
  './data-worker.js?v=V1_6_3',
  './learning-sync.js?v=V1_6_3',
  './practice-lifecycle.js?v=V1_6_3',
  './storage-status-ui.js?v=V1_6_3',
  './',
  './index.html',
  './style.css?v=V1_6_3',
  './app.js?v=V1_6_3',
  './manifest.json?v=V1_6_3',
  './version.json',
  './storage.js?v=V1_6_3',
  './backup-schema.js?v=V1_6_3',
  './study-streak.js?v=V1_6_3',
  './japanese-learning.js?v=V1_6_3',
  './kana-data.js?v=V1_6_3',
  './kana-strokes.js?v=V1_6_3',
  './handwriting-engine.js?v=V1_6_3',
  './version-manager.js?v=V1_6_3',
  './chart-renderer.js?v=V1_6_3',
  './push-config.js?v=V1_6_3',
  './reminder-manager.js?v=V1_6_3',
  './daily-learning.js?v=V1_6_3',
  './kana-reading.js?v=V1_6_3',
  './word-reading.js?v=V1_6_3',
  './jszip.min.js?v=3_10_1',
  './favicon-32.png?v=V1_6_3',
  './apple-touch-icon.png?v=V1_6_3',
  './icon-maskable-512.png?v=V1_6_3',
  './icon-192.png',
  './icon-512.png',
  './icon-192.png?v=V1_6_3',
  './icon-512.png?v=V1_6_3'
];

function inAppScope(url) {
  const target = new URL(url, self.registration.scope);
  const scope = new URL(self.registration.scope);
  return target.origin === scope.origin && target.pathname.startsWith(scope.pathname);
}

async function appWindows() {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return clients.filter(client => inAppScope(client.url));
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const freshRequests = APP_SHELL.map(url => new Request(new URL(url, self.location.href), { cache: 'reload' }));
    await cache.addAll(freshRequests);
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type !== 'SKIP_WAITING') return;
  event.waitUntil((async () => {
    const windows = await appWindows();
    const safe = await Promise.all(windows.map(client => new Promise(resolve => {
      const channel = new MessageChannel();
      const timeout = setTimeout(() => { channel.port1.close(); resolve(false); }, 2000);
      channel.port1.onmessage = message => {
        clearTimeout(timeout);
        channel.port1.close();
        resolve(message.data?.safe === true);
      };
      client.postMessage({ type: 'CAN_ACTIVATE_UPDATE' }, [channel.port2]);
    })));
    if (safe.every(Boolean)) await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const versions = keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME);
    const old = versions.slice(0, -1);
    await Promise.all(old.map(key => caches.delete(key)));
    await self.clients.claim();
    const clients = await appWindows();
    clients.forEach(client => client.postMessage({ type: 'SW_ACTIVATED', version: CACHE_NAME }));
  })());
});

async function networkFirst(request, fallbackUrl) {
  const cache = await caches.open(CACHE_NAME);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(new Request(request, { cache: 'no-store', signal: controller.signal }));
    if (response?.ok) {
      cache.put(request, response.clone()).catch(() => {});
    }
    if (response.status >= 500) return (await cache.match(request)) || (fallbackUrl ? await cache.match(fallbackUrl) : null) || response;
    return response;
  } catch {
    return (await cache.match(request)) || (fallbackUrl ? await cache.match(fallbackUrl) : Response.error());
  } finally { clearTimeout(timeout); }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  const versions = (await caches.keys()).filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME);
  for (const version of versions.reverse()) {
    const previous = await (await caches.open(version)).match(request);
    if (previous) return previous;
  }
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
  let targetUrl = self.registration.scope;
  try {
    const destination = new URL(event.notification.data?.url || './', self.location.href);
    if (inAppScope(destination.href)) targetUrl = destination.href;
  } catch {}
  event.waitUntil((async () => {
    const windows = await appWindows();
    const client = windows.find(item => item.focused) || windows[0];
    if (client) return client.focus();
    return self.clients.openWindow?.(targetUrl);
  })());
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  if (!inAppScope(url.href)) return;
  if (url.pathname.endsWith('/version.json')) {
    // A cached manifest cannot establish what is deployed now.
    event.respondWith(fetch(event.request, { cache: 'no-store' }).catch(() => Response.error()));
    return;
  }

  if (url.pathname.endsWith('/push-config.js')) {
    // Serve the installed configuration immediately. Keep the next online
    // launch up to date even if the server changes the Worker URL in place.
    const cache = caches.open(CACHE_NAME);
    const refresh = fetch(event.request, { cache: 'no-store' });
    event.waitUntil(refresh.then(async response => {
      if (response.ok) await (await cache).put(event.request, response.clone());
    }).catch(() => {}));
    event.respondWith(cache.then(async shell => (await shell.match(event.request)) || refresh));
    return;
  }

  if (event.request.mode === 'navigate') {
    event.respondWith(caches.open(CACHE_NAME).then(async cache => (await cache.match('./index.html')) || networkFirst(event.request, './index.html')));
    return;
  }

  const isStatic = /\.(?:js|css|json|png|svg|webp|ico)$/i.test(url.pathname);
  event.respondWith(isStatic ? cacheFirst(event.request) : networkFirst(event.request));
});
