// ShuyoNote Service Worker — offline PWA.
//
// Strategy:
//   - install: pre-cache the app shell (root HTML + manifest + icon).
//   - activate: drop stale caches from previous versions.
//   - fetch:
//       * navigation (document) → network-first, fall back to cached shell.
//       * static assets (same-origin) → network-first, fall back to cache.
//       * everything else → network only.
// Network-first for assets keeps the app fresh across rebuilds (stale hashed
// assets can linger in old tabs); the cache is the offline fallback. A failed
// asset fetch is caught and never rejects the FetchEvent, so a stale page
// referencing a deleted hashed file can't spam "Failed to fetch".
// This is a "local-first" friendly approach: the note data lives in IndexedDB
// (SQLite via sql.js), not in the HTTP cache, so tables don't conflict.
const CACHE = "shuyonote-shell-v2";
const SHELL = ["/", "/manifest.webmanifest", "/icons/icon.svg"];

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
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put("/", copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match("/").then((r) => r || new Response("", { status: 503 }))),
    );
    return;
  }

  // Static assets: network-first, fall back to cache. Never reject the event —
  // an uncached asset that fails to fetch resolves to a graceful 503 response
  // instead of an unresolved (rejected) FetchEvent.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((r) => r || new Response("", { status: 503, statusText: "Offline" })),
      ),
  );
});
