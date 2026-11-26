// Service worker: lets the dashboard install as an app and keeps its static files available offline.
//
// What it caches: only the stylesheets, scripts, icons and the manifest. Static files are fetched from the
// network first, so a deploy takes effect at once, and the cached copy is used only when the network fails.
// The asset URLs carry a content hash (see src/utils/pages.js), so a stale copy never runs with a newer page.
//
// What it never caches: pages (they depend on the signed-in session and are served no-store), the API,
// the public capture endpoint /b, sign-in and health. Captured request data never lands in the cache.

const CACHE = 'request-bin-static-v1';
const OFFLINE_PAGE = '/offline.html';
const PRECACHE = [OFFLINE_PAGE, '/favicon.svg', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest'];
const STATIC_FILE = /\.(?:js|css|svg|png|webmanifest)$/;
const NOT_CACHED_PATH = /^\/(?:api|b|auth|health)(?:\/|$)/;

self.addEventListener('install', event => {
    event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(PRECACHE)));
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches
            .keys()
            .then(names => Promise.all(names.filter(name => name !== CACHE).map(name => caches.delete(name))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    const { request } = event;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;
    if (NOT_CACHED_PATH.test(url.pathname)) return;

    if (request.mode === 'navigate') {
        // Pages are never cached. Offline, show the offline notice instead of the browser's error page.
        event.respondWith(fetch(request).catch(() => caches.match(OFFLINE_PAGE)));
        return;
    }

    if (STATIC_FILE.test(url.pathname) && url.pathname !== '/sw.js') {
        event.respondWith(networkFirst(request));
    }
});

async function networkFirst(request) {
    const cache = await caches.open(CACHE);
    try {
        const response = await fetch(request);
        if (response.ok) {
            // Keep one copy per file: drop older hashed URLs of the same file
            const url = new URL(request.url);
            for (const key of await cache.keys()) {
                const old = new URL(key.url);
                if (old.pathname === url.pathname && old.search !== url.search) await cache.delete(key);
            }
            cache.put(request, response.clone());
        }
        return response;
    } catch {
        // Exact URL only: an older copy of a file would not match the page that asks for it
        const cached = await cache.match(request);
        if (cached) return cached;
        return Response.error();
    }
}
