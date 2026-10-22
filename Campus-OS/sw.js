// Minimal offline shell worker. It caches static app files for quick startup, but must
// never store Supabase API responses or authenticated school records on this device.
// Increase CACHE_NAME whenever the shell asset set or cache behavior changes.
const CACHE_NAME = 'campus-os-shell-v3';
// App documents and assets needed to render the sign-in shell without a network request.
const APP_SHELL = [
  './',
  './index.html',
  './public.html',
  './campus-config.js',
  './app-persistence.js',
  './manifest.webmanifest',
  './icon.svg'
];
// Only same-origin static assets in these formats participate in the shell cache.
const SAFE_STATIC = /\.(?:html|js|css|svg|webmanifest)$/i;

self.addEventListener('install', (event) => {
  // Pre-cache the static shell, then activate the new worker without waiting for old tabs.
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Delete older Campus OS shell caches while preserving unrelated origin caches.
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((key) => key.startsWith('campus-os-') && key !== CACHE_NAME).map((key) => caches.delete(key))
  )));
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Never cache API, auth, Edge Function, student, attendance, admission, or fee data.
  // These requests may contain private school records or session-specific results.
  if (url.pathname.includes('/rest/') || url.pathname.includes('/auth/') || url.pathname.includes('/functions/')) return;
  if (request.mode === 'navigate') {
    // Navigation is network-first so the newest page is preferred. If offline, serve a
    // previously cached page or fall back to the app shell.
    event.respondWith(fetch(request).then((response) => {
      if (response.ok && response.headers.get('content-type')?.includes('text/html')) {
        caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
      }
      return response;
    }).catch(() => caches.match(request).then((cached) => cached || caches.match('./index.html'))));
    return;
  }
  if (!SAFE_STATIC.test(url.pathname)) return;
  // Static assets are cache-first for fast loads, with a network request populating the
  // cache on first use. This cache contains presentation code, not school records.
  event.respondWith(caches.match(request).then((cached) => {
    const network = fetch(request).then((response) => {
      if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
      return response;
    });
    return cached || network;
  }));
});
