// ShuyoNote Service Worker — offline PWA (production domains only; skipped on
// localhost in main.tsx to avoid stale hashed assets across rebuilds).
//
// The web app is mounted at a sub-path (e.g. /app/), so every URL below is built
// RELATIVE to the service worker's own location (self.location) — never an
// absolute "/" — so the same script works at the domain root or any sub-path.
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
const CACHE = "shuyonote-shell-v4";
const SHELL = ["./", "./manifest.webmanifest", "./icons/icon.svg"];

// A URL string given to Cache.addAll / cache.put is resolved against the worker's
// own script location, so "./" always means "here wherever the app is mounted".
const appRoot = "./";

// Remove cached assets that the current build's HTML no longer references, so an
// old build's hashed files can't linger and 404 later. The built HTML references
// assets as "./assets/index-<hash>.js", so match those (relative) refs.
async function pruneStaleAssets() {
  try {
    const res = await fetch("./", { cache: "no-cache" });
    if (!res.ok) return;
    const html = await res.text();
    const keep = new Set();
    for (const m of html.matchAll(/(?:\.\/)?assets\/[^"'\s)]+/g)) {
      const href = new URL(m[0].replace(/^\.\//, ""), self.location).href;
      keep.add(href);
      keep.add(new URL(href).pathname);
    }
    const assetsDir = new URL("./assets/", self.location).pathname;
    const cache = await caches.open(CACHE);
    const keys = await cache.keys();
    await Promise.all(
      keys
        .filter((req) => {
          const url = new URL(req.url);
          if (url.origin !== self.location.origin) return false;
          return (
            url.pathname.startsWith(assetsDir) &&
            !keep.has(url.href) &&
            !keep.has(url.pathname)
          );
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
            const forReq = res.clone();
            const forRoot = res.clone();
            caches.open(CACHE).then((cache) => {
              cache.put(req, forReq).catch(() => {});
              cache.put(appRoot, forRoot).catch(() => {});
            }).catch(() => {});
          }
          return res;
        })
        .catch(() =>
          caches
            .match(req)
            .then((r) => r || caches.match(appRoot))
            .then((r) => r || new Response("", { status: 503 })),
        ),
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
