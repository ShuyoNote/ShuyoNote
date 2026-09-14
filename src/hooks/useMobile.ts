// Detect small-screen / mobile viewport (<=768px, matches the CSS breakpoint in
// App.css). On mobile the layout collapses the sidebar into an overlay drawer
// (position:fixed) and stacks the right drawers full-screen, so the app should
// default the sidebar closed there. This hook exposes `isMobile` and, when it
// becomes true, seeds the sidebar closed (best-effort; the user can still open
// the drawer via the activity bar).
import { useEffect, useState } from "react";
import { useActivity } from "../store/activity";

/**
 * 窄屏断点（px）——**JS 与 CSS 必须是同一个数**。
 *
 * 这个数字此前散落在三处：这里的 `768`、App.css 里的 `720` 与 `760`。
 * 三处不一致的后果不是"差几个像素"，而是**同一块 UI 在 721~768px 之间
 * 一半按窄屏算、一半按宽屏算**：JS 认为该走底部弹层、CSS 还按桌面锚定浮层，
 * 于是浮层既没有锚点、也没拿到弹层样式，直接落在左上角。
 *
 * 现在只有这一个来源：App.css 末尾那段 `@media (max-width: 768px)` 与
 * `usePopover` 的 `isSheet` 判定都读它。**改这个数就要同时改那段 CSS**——
 * `scripts/verify-mobile-overlays.mjs` 会断言 CSS 侧命中的确实是 768
 *（`max-width:769px` 也命中、且不是残留的 760），改了这里忘了改那边就会红。
 */
export const MOBILE_BREAKPOINT_PX = 768;

/** 与 `MOBILE_BREAKPOINT_PX` 同源的媒体查询串。 */
export const MOBILE_QUERY = `(max-width: ${MOBILE_BREAKPOINT_PX}px)`;

/** 纯视口判定（不依赖 matchMedia，便于在无 DOM 环境里直接算）。 */
export function isNarrowViewport(width?: number): boolean {
  const w =
    typeof width === "number"
      ? width
      : typeof window === "undefined"
        ? Number.POSITIVE_INFINITY
        : window.innerWidth;
  return w <= MOBILE_BREAKPOINT_PX;
}

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
