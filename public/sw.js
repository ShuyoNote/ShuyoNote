// ShuyoNote Service Worker — offline PWA (production domains only; skipped on
// localhost in main.tsx to avoid stale hashed assets across rebuilds).
//
// Strategy:
//   - install: pre-cache the app shell (root HTML + manifest + icon).
//   - activate: drop caches from other versions, then prune cached assets no
//     longer referenced by the current shell HTML (self-healing across builds).
//   - fetch:
//       * navigation (document) → network-first, fall back to cached shell.
//       * static assets (same-origin) → network-first, fall back to cache.
//       * everything else → network only.
// The app is local-first (note data in IndexedDB), so the HTTP cache only holds
// the static shell + assets; a failed asset fetch resolves to Response.error()
// (never rejects the FetchEvent) instead of a misleading "Offline" response.
const CACHE = "shuyonote-shell-v3";
const SHELL = ["./", "./manifest.webmanifest", "./icons/icon.svg"];

// Remove cached /assets/* entries that the current build's HTML no longer
// references, so an old build's hashed files can't linger and 404 later.
async function pruneStaleAssets() {
  try {
    const res = await fetch("/", { cache: "no-cache" });
    if (!res.ok) return;
    const html = await res.text();
    const keep = new Set();
    for (const m of html.matchAll(/\/assets\/[^"'\s)]+/g)) keep.add(m[0]);
    const cache = await caches.open(CACHE);
    const keys = await cache.keys();
    await Promise.all(
      keys
        .filter((req) => {
          const url = new URL(req.url);
          if (url.origin !== self.location.origin) return false;
          return url.pathname.startsWith("/assets/") && !keep.has(url.pathname) && !keep.has(url.href);
        })
        .map((req) => cache.delete(req)),
    );
  } catch {
    /* best-effort */
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => pruneStaleAssets())
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle same-origin; let cross-origin (fonts, etc.) pass through.
  if (url.origin !== self.location.origin) return;
  if (req.method !== "GET") return;

  // Navigation requests: network-first, fall back to cached shell for offline.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put("/", copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match("/").then((r) => r || new Response("", { status: 503 }))),
    );
    return;
  }

  // Static assets: network-first, fall back to cache. A failure never rejects
  // the FetchEvent — it resolves to Response.error() so the browser reports the
  // real problem without us fabricating an "Offline" status.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || Response.error())),
  );
});
