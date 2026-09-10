// Detect small-screen / mobile viewport (<=768px, matches the CSS breakpoint in
// App.css). On mobile the layout collapses the sidebar into an overlay drawer
// (position:fixed) and stacks the right drawers full-screen, so the app should
// default the sidebar closed there. This hook exposes `isMobile` and, when it
// becomes true, seeds the sidebar closed (best-effort; the user can still open
// the drawer via the activity bar).
import { useEffect, useState } from "react";
import { useActivity } from "../store/activity";

const MOBILE_QUERY = "(max-width: 768px)";

/** Pure viewport check (unit-testable): true when <=768px. */
export function isMobileViewport(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(MOBILE_QUERY).matches;
}

export function useMobile(): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(isMobileViewport);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(MOBILE_QUERY);
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  // On entering the mobile viewport, close the sidebar so the main area is full
  // width (the sidebar becomes an overlay drawer on mobile, not an inline column).
  // 不写 localStorage：这是屏幕尺寸导致的布局状态，不该覆盖桌面端的侧栏偏好。
  useEffect(() => {
    if (isMobile) {
      useActivity.getState().setSidebarOpen(false, { persist: false });
    }
  }, [isMobile]);

  return isMobile;
}
