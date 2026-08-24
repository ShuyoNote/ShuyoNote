import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

// Surface uncaught runtime errors for diagnosis (production-safe: console only).
window.addEventListener("error", (e) => {
  console.error("[ShuyoNote]", e.error || e.message);
});
window.addEventListener("unhandledrejection", (e) => {
  console.error("[ShuyoNote] unhandled rejection:", e.reason);
});

// Register the offline Service Worker in production builds only. In dev it would
// fight the Vite dev server's module/HMR caching, so we gate it on PROD.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js")
      .catch((e) => console.error("[ShuyoNote] SW register failed", e));
  });
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
