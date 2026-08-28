import "./lib/polyfills";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { version } from "../package.json";

// The lazily-loaded @excalidraw/excalidraw bundle reads `process.env.NODE_ENV` at
// module top-level; define `process` in the browser so it doesn't throw
// "process is not defined", and keep NODE_ENV as "production" (never "development").
(globalThis as any).process = (globalThis as any).process ?? Object.assign(Object.create(null), { env: { NODE_ENV: "production" } });

// Browser tab / window title carries the live build version (mirrors the desktop
// window title set in src-tauri/src/lib.rs).
document.title = `ShuyoNote 数友笔记 · v${version}`;
// Marker so we can confirm which bundle the browser is actually running (stale
// module caches otherwise make the console/behaviour lag behind the code).
console.info(`[ShuyoNote] bootstrap v${version}`);

// Surface uncaught runtime errors for diagnosis (production-safe: console only).
window.addEventListener("error", (e) => {
  console.error("[ShuyoNote]", e.error || e.message);
});
window.addEventListener("unhandledrejection", (e) => {
  console.error("[ShuyoNote] unhandled rejection:", e.reason);
});

// Register the offline Service Worker in production builds only. In dev it would
// fight the Vite dev server's module/HMR caching, so we gate it on PROD. We also
// skip it on localhost (the `pnpm preview` / dev host): there the SW caches an
// app shell + hashed assets that go stale across rebuilds, showing an old
// version and "Failed to load resource" errors after each build. A real
// production domain keeps the offline PWA; localhost stays cache-fresh.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  const host = window.location.hostname;
  const isLocalhost = host === "localhost" || host === "127.0.0.1";
  if (isLocalhost) {
    // A previous build may have registered a SW here; it still controls this
    // page and serves a stale cached shell + old hashed assets. Unregister it,
    // clear the caches, and reload once so the user lands on the fresh bundle.
    window.addEventListener("load", () => {
      (async () => {
        const regs = await navigator.serviceWorker.getRegistrations().catch(() => []);
        const hadSw = regs.length > 0 || !!navigator.serviceWorker.controller;
        await Promise.all(regs.map((r) => r.unregister().catch(() => false)));
        if (window.caches?.keys) {
          const keys = await window.caches.keys().catch(() => []);
          await Promise.all(keys.map((k) => window.caches.delete(k).catch(() => false)));
        }
        if (hadSw && !window.location.search.includes("swreload")) {
          const u = new URL(window.location.href);
          u.searchParams.set("swreload", "1");
          window.location.replace(u.toString());
        }
      })();
    });
  } else {
    window.addEventListener("load", () => {
      navigator.serviceWorker
        .register("/sw.js")
        .catch((e) => console.error("[ShuyoNote] SW register failed", e));
    });
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
