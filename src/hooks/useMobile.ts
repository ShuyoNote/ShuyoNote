// Detect small-screen / mobile viewport (<=768px, matches the CSS breakpoint in
// App.css). On mobile the layout collapses the sidebar into an overlay drawer
// (position:fixed) and stacks the right drawers full-screen, so the app should
// default the sidebar closed there. This hook exposes `isMobile` and, when it
// becomes true, seeds the sidebar closed (best-effort; the user can still open
// the drawer via the activity bar).
import { useEffect, useState } from "react";
import { useActivity } from "../store/activity";

// Re-exported from src/lib/platform/shape.ts (stage 0, R203): the PURE predicates moved to a
// hook-free module so "is this a phone" no longer lives inside a side-effecting hook.
// These are re-exports on purpose -- existing call sites stay byte-identical.
export {
  MOBILE_BREAKPOINT_PX,
  MOBILE_QUERY,
  isNarrowViewport,
  SHORT_VIEWPORT_MAX_PX,
  SHORT_QUERY,
  isShortViewport,
  isMobileOverlayViewport,
  isMobileViewport,
  COARSE_POINTER_QUERY,
  hasCoarsePointer,
} from "../lib/platform/shape";
import { MOBILE_QUERY, SHORT_QUERY, isMobileOverlayViewport, isMobileViewport } from "../lib/platform/shape";


/**
 * **导出 PDF 期间**：响应式判定一律按「桌面」算。
 *
 * 为什么必须这样：`PrintToPdf` 的版面宽度是**纸张正文宽度** —— A4 210mm 减去 12mm×2 页边距
 * ≈ **703 CSS px**，落在 768px 断点以下 ⇒ 打印时 `matchMedia` 会把桌面应用判成手机，
 * React 真的重渲染成移动版（真读数：导出 PDF 里出现移动端的「阅读」屏 + 底部提示）。
 * 导出期间带上 `pdf-exporting` 类 ⇒ 这里返回 true，两个响应式 hook 都按桌面返回。
 *
 * ⚠️ 只是「打印期冻结」，屏幕上的窄窗口行为**不变**（窄窗口本该是移动版式）。
 */
export function isPrintLayout(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.classList.contains("pdf-exporting");
}

export function useMobile(): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() => isMobileViewport() && !isPrintLayout());

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(MOBILE_QUERY);
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches && !isPrintLayout());
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

  return isMobile && !isPrintLayout();
}

/**
 * **浮层形态**视口（窄**或**矮）——与 `@media (max-width:768px), (max-height:520px)`
 * 逐字对应，而且**会跟着视口变化**（旋转、分屏、把窗口拖矮都算）。
 *
 * 与 `useMobile()` 只差一个字，用错就是 bug：`useMobile()` 只看**宽度**，回答"布局要不要
 * 换成窄屏形态"（侧栏收成抽屉）；这一个回答"浮层 / 面板内部栏要不要换成整屏 / 抽屉形态"，
 * 横屏手机（792×360：不窄但矮）必须也算。
 * PDF 阅读器的目录栏与批注栏 2026-09-15 真机出问题，根因就是它俩按"并排的列"渲染，
 * 在 360 宽下把正文挤出屏幕（页面图 x=99 / 宽 306 ⇒ 右溢出）。
 */
export function useMobileOverlayViewport(): boolean {
  const [isOverlay, setIsOverlay] = useState<boolean>(() => isMobileOverlayViewport() && !isPrintLayout());

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    // 回调里重新**算一遍**（而不是读 `e.matches`）：两个查询谁变了都要重算，
    // 而 `e.matches` 只说那一条查询自己的结果。
    return subscribeOverlayViewport((q) => window.matchMedia(q), () =>
      setIsOverlay(isMobileOverlayViewport() && !isPrintLayout()),
    );
  }, []);

  // ⚠️ 导出 PDF 期间不算"窄/矮"（见 `isPrintLayout`）：纸张正文宽 ≈703px 会掉进断点。
  return isOverlay && !isPrintLayout();
}

/**
 * 订阅"窄**或**矮"这两条媒体查询，任一变化就调 `onChange`，返回取消订阅。
 *
 * 抽成纯函数（只依赖一个 `matchMedia` 注入）是为了**能被单测钉住**：这里最容易犯的错
 * 是只订阅窄屏那一条——手机竖屏转横屏（360 → 792 宽）时回调不会触发，阅读器就留着
 * "桌面三栏"的形态把正文挤出屏幕（2026-09-15 真机量到的就是它）。React 渲染测试要额外
 * 依赖，而这条不变量值得一条**便宜**的断言。
 */
export function subscribeOverlayViewport(
  matchMedia: (query: string) => Pick<MediaQueryList, "addEventListener" | "removeEventListener">,
  onChange: () => void = () => {},
): () => void {
  const narrow = matchMedia(MOBILE_QUERY);
  const short = matchMedia(SHORT_QUERY);
  narrow.addEventListener("change", onChange);
  short.addEventListener("change", onChange);
  return () => {
    narrow.removeEventListener("change", onChange);
    short.removeEventListener("change", onChange);
  };
}
