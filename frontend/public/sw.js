/*
 * Readerr service worker — makes the app installable and fully usable
 * offline. All data lives in IndexedDB (the service worker never touches
 * it); this only caches the static shell.
 *
 * Strategy:
 *  - navigations: network-first, falling back to the cached page (then /)
 *  - assets:      stale-while-revalidate
 *
 * Deliberately absent: an install-time crawl of the whole asset graph. The
 * build emits ~250 fingerprinted chunks, and fetching them in a burst gets
 * rate-limited by static hosts (503s) — which then hit the app's own lazy
 * imports, since they queue behind the same limit. The cache fills as you
 * browse instead.
 *
 * Bump CACHE_VERSION to invalidate everything after a breaking change.
 */
const CACHE_VERSION = 'readerr-v3';

// Everything under this prefix belongs to this app. Cache Storage is keyed by
// ORIGIN, not by service-worker scope, so under muxerr (or any host serving two
// of these apps on one origin) a bare "delete every key that isn't mine" makes
// the apps evict each other's caches on every activation. Scoping deletion to
// this prefix keeps the version bump working — CACHE_VERSION is
// `<CACHE_PREFIX>vN` — without touching a neighbour.
const CACHE_PREFIX = 'readerr-';

// The app may be hosted under a sub-path. The SW file lives at `<base>sw.js`,
// so its own path yields the base.
const BASE = self.location.pathname.replace(/sw\.js$/, ''); // '/' or '/readerr/'

// Requests that must always hit the network, never the cache.
//
// Dev-server module URLs: serving them stale breaks the app after code changes.
// (The worker shouldn't be registered in dev at all, but belt and braces.)
//
// API endpoints: once the client resolves its sync URL from BASE_URL these live
// under the app's own base — inside this worker's scope. A stale-while-
// revalidate /sync/pull hands the client a response it has already applied and
// reports success: silent data loss. And GET /backup would otherwise be served
// from cache too. Matched on pathname, so the query string (?since=, ?url=) is
// irrelevant; the exact endpoints are anchored so a page route like /backups/
// is not caught, and /sync//push/ stay prefix-matched because the app prefix is
// not known here.
const UNCACHEABLE = [
  /\/src\//,
  /\/@/,
  /\/node_modules\//,
  /\/sync\//,
  /\/healthz$/,
  /\/backup$/,
  /\/push\//,
  /\/title$/,
  /\/dbsize$/,
];

// Throttling and blips, not verdicts — worth asking again.
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/**
 * Fetch, retrying a rate-limit or a 5xx with exponential backoff. Safe
 * because everything here is a GET, and hashed assets are immutable.
 * Returns the last response even if it's still failing; only a network
 * error throws.
 */
async function fetchWithRetry(request, attempts = 3) {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(request);
      if (!RETRYABLE.has(response.status) || attempt >= attempts - 1) return response;
    } catch (err) {
      if (attempt >= attempts - 1) throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
  }
}

/** Cache a response only if it's actually good (see the 404 note below). */
async function cacheIfOk(request, response) {
  if (!response.ok) return;
  const cache = await caches.open(CACHE_VERSION);
  await cache.put(request, response);
}

/**
 * Look up a cached response, ignoring Vary. Some hosts (and Astro's own
 * preview server) send `Vary: Origin` on static files, which otherwise makes
 * a stored entry miss whenever the replaying request's Vary key differs —
 * e.g. a module fetched no-cors on first load, then requested again on a
 * reload. That silently broke offline serving for already-cached assets.
 * Safe here: everything cached is a same-origin GET of our own immutable
 * build output, with no content negotiation.
 */
function matchCached(request) {
  return caches.match(request, { ignoreVary: true });
}

self.addEventListener('install', (event) => {
  // The shell only — one request, so it can't rate-limit anything. Without
  // it the offline navigation fallback below has nothing to fall back to
  // until the user has happened to visit the base page online.
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.add(new Request(BASE, { cache: 'reload' })))
      .catch(() => {}) // offline at install time is not a failure
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE_VERSION)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== location.origin) return;
  if (UNCACHEABLE.some((re) => re.test(url.pathname))) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetchWithRetry(request, 2)
        .then(async (response) => {
          // A 404 or a 5xx error page must never be cached: it would be
          // served as this URL's offline copy until the cache is renamed.
          if (!response.ok) {
            return (await matchCached(request)) ?? response;
          }
          event.waitUntil(cacheIfOk(request, response.clone()));
          return response;
        })
        // Offline. Every branch must produce a real Response — resolving
        // respondWith with undefined makes the browser report a confusing
        // synthetic failure against the server.
        .catch(async () =>
          (await matchCached(request)) ?? (await matchCached(BASE)) ?? Response.error()
        )
    );
    return;
  }

  event.respondWith(
    matchCached(request).then((cached) => {
      const network = fetchWithRetry(request)
        .then((response) => {
          if (response.ok) event.waitUntil(cacheIfOk(request, response.clone()));
          return response;
        })
        .catch(() => cached ?? Response.error());
      if (!cached) return network;
      // Serve the cached copy and revalidate behind it — but keep the
      // worker alive long enough for that write to land.
      event.waitUntil(network);
      return cached;
    })
  );
});
