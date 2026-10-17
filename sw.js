/* Pro Daily Link service worker — app shell works offline.
 *
 * Strategy:
 * - Navigations (opening the app): network first, cached app page as fallback
 *   so the workspace opens with no connection at all.
 * - Same-origin static assets (JS/CSS/fonts/images): pinned assets (`?v=...`)
 *   are immutable, so they are cache-first — instant on repeat visits and
 *   never stale, because a new deploy ships a new URL. Unpinned assets are
 *   network first with cache fallback + background refresh, so an updated
 *   file is never masked by an old cached copy on a flaky connection.
 *   Assets self-populate the cache as they are used, so no hardcoded version
 *   list can go stale.
 * - /api/* is never cached: data always comes live, or from the app's own
 *   last-known-state cache (offline.js) which marks itself as stale.
 */
'use strict';
const SHELL_CACHE = 'pdl-shell-v1';
const APP_PAGE = '/app';

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL_CACHE).then(cache => cache.add(APP_PAGE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== SHELL_CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  // Opening the app: live page when possible, cached shell offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => {
          const copy = response.clone();
          caches.open(SHELL_CACHE).then(cache => cache.put(APP_PAGE, copy));
          return response;
        })
        .catch(() => caches.match(APP_PAGE).then(cached => cached || caches.match('/')))
    );
    return;
  }

  // Static assets. Pinned assets (?v=...) are immutable: serve cache-first so
  // a slow or flaky connection can never fall back to a half-old/half-new
  // mix, and refresh the cache entry from the network in the background.
  // Unpinned assets stay network-first so edits show up immediately.
  const pinned = url.searchParams.has('v');
  event.respondWith(
    caches.open(SHELL_CACHE).then(async cache => {
      const cached = await cache.match(request);
      if (pinned && cached) {
        fetch(request).then(response => { if (response.ok) cache.put(request, response.clone()); }).catch(() => {});
        return cached;
      }
      const network = fetch(request).then(response => {
        if (response.ok) cache.put(request, response.clone());
        return response;
      }).catch(() => null);
      return (await network) || cached || Response.error();
    })
  );
});
