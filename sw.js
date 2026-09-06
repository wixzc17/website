// Static PWA Service Worker
// HTML 页面用 network-first（每次拿最新版，离线才用缓存）；静态资源用 cache-first
const CACHE_NAME = 'static-pwa-v3';
const PRECACHE = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  // API 请求走网络，不缓存
  if (url.pathname.startsWith('/api/')) return;
  // 跨域请求不缓存
  if (url.origin !== self.location.origin) return;

  const isHTML = event.request.mode === 'navigate' ||
    url.pathname.endsWith('.html') ||
    url.pathname === '/';

  if (isHTML) {
    // HTML 页面：network-first，保证每次都是最新版
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.status === 200 && response.type === 'basic') {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
  } else {
    // 静态资源（CSS/JS/图片）：cache-first
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request)
          .then((response) => {
            if (response.status === 200 && response.type === 'basic') {
              const clone = response.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
            }
            return response;
          })
          .catch(() => cached);
      })
    );
  }
});
