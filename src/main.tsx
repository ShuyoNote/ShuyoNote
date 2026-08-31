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
// skip it on localhost (the `pnpm preview` / dev host) AND inside the Tauri
// desktop app: there the SW caches an app shell + hashed assets that go stale
// across rebuilds/updates, showing an old version and "Failed to load resource"
// errors after each update. A real production WEB domain keeps the offline PWA;
// localhost & desktop stay cache-fresh.
//
// NOTE: the desktop WebView2 origin is `tauri.localhost` (NOT `localhost`), so a
// naive `hostname === "localhost"` check would miss it and register a SW on
// desktop — the very cause of "must hard-refresh after update". We therefore
// also treat any Tauri environment (`__TAURI_INTERNALS__`) as a no-SW host.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  const host = window.location.hostname;
  const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  const isLocalhost = host === "localhost" || host === "127.0.0.1" || host === "tauri.localhost";
  if (isLocalhost || isTauri) {
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
        .register("./sw.js")
        .catch((e) => console.error("[ShuyoNote] SW register failed", e));
    });
  }
}

// Fade out and remove the static splash screen once the app has mounted, so the
// initial white/blank window is replaced by a branded animation. The splash is a
// sibling of #root in index.html and renders before the JS bundle loads; here we
// only hide it after React has committed the first paint.
//
// Robustness: rely on `DOMContentLoaded` (fires as soon as the doc is parsed,
// without waiting for every sub-resource) plus a hard timeout, so the splash can
// never stay forever even if the browser `window.load` is blocked by a pending
// resource or a stale cache. On a fatal module error we also force-hide it.
function hideSplash() {
  const el = document.getElementById("app-splash");
  if (!el || el.classList.contains("is-hide")) return;
  // Wait one frame so the freshly-rendered app is visible before we fade out.
  requestAnimationFrame(() => el.classList.add("is-hide"));
  // Remove the node after the CSS transition finishes.
  window.setTimeout(() => el.remove(), 500);
}

// DOMContentLoaded is more dependable than window.load for showing the app (it
// doesn't wait for all assets, so it can't be blocked by a hung resource).
document.addEventListener("DOMContentLoaded", () => {
  window.setTimeout(hideSplash, 60);
});
// Safety net: always hide after a short timeout, even if load events never fire.
window.setTimeout(hideSplash, 1500);

// On a resource / module / runtime failure, surface the real error ON the splash
// so the user can screenshot the diagnostic without DevTools. This distinguishes
// "a hashed asset 404'd (stale shell)" from "the bundle threw at startup".
function showStartupError(label: string, detail: unknown) {
  const el = document.getElementById("app-splash");
  if (!el) return;
  el.classList.add("is-hide");
  requestAnimationFrame(() => {
    // Rebuild a small diagnostic panel in place of the splash.
    el.classList.remove("is-hide");
    el.innerHTML =
      '<div style="max-width:560px;margin:24px;padding:20px 22px;border-radius:12px;background:#1c2340;border:1px solid rgba(255,255,255,.18);text-align:left;font-family:Segoe UI,system-ui,sans-serif;color:#fff">' +
      `<div style="font-weight:700;margin-bottom:10px;color:#ffb3b3">启动失败：${escapeHtml(label)}</div>` +
      `<div style="font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-all;color:rgba(255,255,255,.85)">${escapeHtml(String(detail ?? ""))}</div>` +
      '<div style="margin-top:14px;font-size:12px;color:rgba(255,255,255,.6)">请截图此信息反馈；或重装/清缓存后重试。</div>' +
      "</div>";
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Resource load failures (404 of a hashed asset) fire `error` on window with
// the failing resource in `e.target`.
window.addEventListener("error", (e) => {
  const t = e.target as HTMLElement | HTMLScriptElement | HTMLLinkElement;
  const src = (t as HTMLScriptElement)?.src || (t as HTMLLinkElement)?.href;
  const msg = src ? `资源加载失败（可能为缓存/旧版本残留）：${src}` : (e.error?.message ?? e.message ?? String(e.error ?? ""));
  window.setTimeout(() => showStartupError("资源加载失败", msg), 30);
});
window.addEventListener("unhandledrejection", (e) => {
  window.setTimeout(() => showStartupError("运行时错误", e.reason), 30);
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
