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

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
