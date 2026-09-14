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

/**
 * 纯视口判定（不依赖 matchMedia，便于在无 DOM 环境里直接算）。
 *
 * ⚠️ **只看宽度**，这是 2026-09-15 特意写清楚的一条口径（此前含糊，出了 bug）：
 *
 *   `isNarrowViewport()` 回答的是「**布局要不要换成窄屏形态**」——侧栏收成抽屉、
 *   右栏整屏叠加、主区 `padding-right` 让位。这些是**宽度**问题（横向没地方放），
 *   高度再矮也不改变这个结论，所以它**不该**把高度算进来：
 *   792×360 的横屏手机仍然放得下"侧栏 + 正文"两列。
 *
 *   但**浮层形态**是另一回事，它同时受宽度和高度约束（见 `isShortViewport`）：
 *   792×360 走宽屏分支 ⇒ `.set-dialog` 用桌面样式（`min-width:640px`、
 *   高度按内容走）⇒ 实测 y=24 / h=420 / bottom=**444**，**底部 84px 被裁在屏外**。
 *   所以浮层形态的判定必须是「**窄 或 矮**」，而不是只看窄。
 *
 *   一句话：**布局看宽度，浮层看宽度和高度。**
 */
export function isNarrowViewport(width?: number): boolean {
  const w =
    typeof width === "number"
      ? width
      : typeof window === "undefined"
        ? Number.POSITIVE_INFINITY
        : window.innerWidth;
  return w <= MOBILE_BREAKPOINT_PX;
}

/**
 * 矮视口断点（px）——**JS 与 CSS 必须是同一个数**。
 *
 * CSS 侧是 `src/App.css` 末尾那段 `@media (max-height: 520px)`；
 * 改了这里忘了改那边，`verify-mobile-overlays.mjs` 会红（它同时量 JS 判定与 CSS 命中）。
 */
export const SHORT_VIEWPORT_MAX_PX = 520;

/** 与 `SHORT_VIEWPORT_MAX_PX` 同源的媒体查询串。 */
export const SHORT_QUERY = `(max-height: ${SHORT_VIEWPORT_MAX_PX}px)`;

/**
 * 纯视口判定：**矮视口**（高度 ≤ 520px）——横屏手机、分屏、以及被拖得很矮的桌面窗口。
 *
 * 用途**只有一个**：决定浮层取哪种形态。大面板（设置 / 存储 / 插件管理 / 命令面板 /
 * 公式编辑器）在矮视口下必须和窄屏一样整屏 + 内部滚动；否则它们的固定高度会超出
 * 可视区，底部那一块（含「保存 / 关闭」）被裁在屏外且滚不到。
 */
export function isShortViewport(height?: number): boolean {
  const h =
    typeof height === "number"
      ? height
      : typeof window === "undefined"
        ? Number.POSITIVE_INFINITY
        : window.innerHeight;
  return h <= SHORT_VIEWPORT_MAX_PX;
}

/** 浮层形态判定：窄**或**矮都算（CSS 侧是 `@media (max-width:768px), (max-height:520px)`）。 */
export function isMobileOverlayViewport(width?: number, height?: number): boolean {
  return isNarrowViewport(width) || isShortViewport(height);
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
  const [isOverlay, setIsOverlay] = useState<boolean>(() => isMobileOverlayViewport());

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    // 回调里重新**算一遍**（而不是读 `e.matches`）：两个查询谁变了都要重算，
    // 而 `e.matches` 只说那一条查询自己的结果。
    return subscribeOverlayViewport((q) => window.matchMedia(q), () =>
      setIsOverlay(isMobileOverlayViewport()),
    );
  }, []);

  return isOverlay;
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
