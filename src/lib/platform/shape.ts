/**
 * **形态判定**（阶段 0，R203 ⇒ owner 拍「单立，走乙丙」）：把"是不是手机"从媒体查询与 hook 里
 * **拿出来**，收敛成**这一处的纯函数** ✓。
 *
 * ⛔ **本模块只导出纯函数与常量** ✗ —— ⛔ 不许有订阅、不许有副作用 hook ✗
 * （教训逐字：`useMobile()` 那个 hook 会在进窄屏时**强制把侧栏关掉** ✓，在第二处挂它
 *  ⇒ **第二个订阅者** ⇒ 把用户手动打开的抽屉压回去 ✗ —— 实测三条抽屉断言因此全红 ✓）。
 * ⇒ 要"订阅"请去 `src/hooks/useMobile.ts` ✓；这里只回答**给定尺寸／能力时，是什么形态** ✓。
 *
 * ⚠️ **语义一个字都没改** ✗：下面这些常量的数值、判定的口径与注释，全部**逐字**来自
 * `src/hooks/useMobile.ts`（原处 **re-export** ✓ ⇒ 调用点一个都不用改 ✓）。
 */

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

/**
 * ⭐ **指针能力**查询串（阶段 0 新增 ✓）——**全仓唯一出处** ✓。
 *
 * 为什么要它：**触屏没有 hover** ✗ ⇒ 靠 `:hover` 才显形的操作（导出／删除按钮、
 * 卡片操作）在手机上**等于不存在** ✓ —— `scripts/verify-mobile-layout.mjs` 逐字记着
 * 这条真机事故：「触屏没有 hover，靠 `:hover` 显形的 **22×22** 等于"删不掉、导不出"」✓。
 * 那条门禁原来把这个串**内联了两处** ✗（`:395`／`:636` ✓）⇒ 收敛到**这一处** ✓，
 * 门禁改为**从本文件把串读出来**再传进浏览器 ✓（⛔ 门禁里不再留字面量 ✗）。
 *
 * ⚠️ 它是**能力**查询，不是**尺寸**查询 ✓ —— 所以⛔ 不并入 `MOBILE_QUERY` ✗：
 * 一个 1280 宽的触屏平板同样是 `(hover: none)` ✓，而它按宽度算**不是**手机 ✓。
 */
export const COARSE_POINTER_QUERY = "(hover: none)";

/** 纯能力判定：当前是不是**粗指针**（触屏／没有 hover ✓）。无 DOM ⇒ `false` ✓（与 `isMobileViewport` 同口径 ✓）。 */
export function hasCoarsePointer(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(COARSE_POINTER_QUERY).matches;
}
