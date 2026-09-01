// Boot-time scripts: Service Worker self-heal + boot diagnostic. Moved OUT of
// index.html into this external file so the CSP can use `script-src 'self'`
// WITHOUT `'unsafe-inline'` — closing the inline-script XSS vector. A plain
// `<script src>` in <head> is synchronous and still runs during HTML parse
// (before the app bundle), so the execution order is unchanged.

// Self-heal legacy Service Worker / caches BEFORE any bundle loads. A stale SW
// from an older build can serve an old index.html that references hashed assets
// no longer present after an update → JS 404 → the app never mounts and the
// splash screen stays forever. This runs during HTML parse (before the app JS
// bundle), so even a page served by a stale SW will unregister it, clear caches,
// and force one reload onto the fresh bundle.
(function () {
  try {
    var hadSw = false;
    var isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
    var host = window.location.hostname;
    var isLocal = host === "localhost" || host === "127.0.0.1" || host === "tauri.localhost";
    // Only self-heal in local/desktop hosts (where we deliberately never keep a
    // SW). A real production web domain keeps its offline PWA.
    if (("serviceWorker" in navigator) && isLocal) {
      navigator.serviceWorker.getRegistrations().then(function (regs) {
        hadSw = regs.length > 0 || !!navigator.serviceWorker.controller;
        return Promise.all(regs.map(function (r) { return r.unregister().catch(function () { return false; }); }));
      }).then(function () {
        if (window.caches && window.caches.keys) {
          return window.caches.keys().then(function (keys) {
            return Promise.all(keys.map(function (k) { return window.caches.delete(k).catch(function () { return false; }); }));
          });
        }
      }).then(function () {
        if (hadSw && window.location.search.indexOf("swreload") === -1) {
          var u = new URL(window.location.href);
          u.searchParams.set("swreload", "1");
          window.location.replace(u.toString());
        }
      }).catch(function () {});
    }
  } catch (e) { /* never block the app */ }
})();

// Boot-diagnostic (runs even if the main bundle fails): if the app bundle didn't
// mount into #root within a deadline, surface the failing resource / runtime
// error on the splash. Resource-load failures do NOT trigger window.onerror, so
// we capture them via the capture phase; runtime errors during bundle evaluation
// DO trigger window.onerror.
(function () {
  var failed = [];
  var rtErr = "";
  function onResErr(e) {
    var t = e.target;
    var src = (t && (t.src || t.href)) || "";
    if (src && failed.indexOf(src) === -1) failed.push(src);
  }
  function onRtErr(e) {
    if (!rtErr) rtErr = (e && (e.message || (e.error && e.error.message))) || String(e || "");
  }
  try { window.addEventListener("error", onResErr, true); } catch (e) {}
  try { window.addEventListener("error", onRtErr); } catch (e) {}
  function showDiagnostic() {
    var root = document.getElementById("root");
    var booted = root && root.childElementCount > 0 && !document.getElementById("app-splash");
    if (booted) return;
    var el = document.getElementById("app-splash");
    if (!el || el.classList.contains("is-hide")) return;
    var parts = [];
    if (failed.length) parts.push("失败的资源：<br/>" + failed.map(function (s) { return escapeHtml(s); }).join("<br/>"));
    if (rtErr) parts.push("运行时错误：" + escapeHtml(rtErr));
    var msg = parts.length
      ? parts.join("<br/><br/>")
      : "主 bundle 未执行（#root 为空），且未捕获到资源/运行时错误。可能为主 JS 未开始加载或协议层问题。<br/>请截图此信息反馈。";
    el.innerHTML = '<div style="max-width:640px;margin:24px;padding:20px 22px;border-radius:12px;background:#1c2340;border:1px solid rgba(255,255,255,.18);text-align:left;font-family:Segoe UI,system-ui,sans-serif;color:#fff">' +
      '<div style="font-weight:700;margin-bottom:10px;color:#ffb3b3">启动错误</div>' +
      '<div style="font-size:12px;line-height:1.7;white-space:pre-wrap;word-break:break-all;color:rgba(255,255,255,.85)">' + msg + '</div>' +
      '<div style="margin-top:14px;font-size:12px;color:rgba(255,255,255,.6)">请截图此信息反馈。</div></div>';
  }
  function escapeHtml(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
  function check() { setTimeout(showDiagnostic, 2600); }
  if (document.readyState === "complete" || document.readyState === "interactive") check();
  else document.addEventListener("DOMContentLoaded", check);
})();
