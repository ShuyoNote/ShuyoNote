// 把「窗口 inset / 软键盘高度」变成 CSS 变量，供 App.css 使用。
//
// ## 为什么不能只靠 env(safe-area-inset-*)
//
// `index.html` 里写了 `viewport-fit=cover`，App.css 里也到处用
// `env(safe-area-inset-top/bottom/...)`。**在 Android 上这些全是 0**：
// WebView 的 safe-area inset 取自**屏幕物理刘海（display cutout）**，不是系统状态栏。
// 实测（Mate 40 / Android 12，密度 3.0）：`dumpsys` 里状态栏 inset 是 123 设备 px
// （= 41 CSS px），而四个方向的 `env()` **都是 0px**。于是在 edge-to-edge 下
// 没有任何东西把内容让开状态栏 —— 标题与系统时间叠字，而且**顶部 41px 是触摸死区**。
//
// ## 为什么不能只靠 visualViewport（本次实测推翻的假设）
//
// Tauri/Android 的软键盘模式是 manifest 默认的 `adjustResize`，但在
// `enableEdgeToEdge()`（= `setDecorFitsSystemWindows(false)`）之下 **adjustResize 失效**：
// 系统不会为 IME 缩小窗口。实测键盘弹起后 `innerHeight` 与 `visualViewport.height`
// **都不变**，`interactive-widget=resizes-content` 也不生效
// ⇒ **web 层无法察觉键盘**，只能由壳层把 IME 的窗口 inset 送进来。
//
// ## 两个数据源 + 一条不重复计算的规则
//
// 1. **壳层推送**（`window.__SHUYONOTE_INSETS__({top,right,bottom,left,ime})`，单位 CSS px）
//    —— Android 上唯一真实来源。由 `scripts/android-mobile-shell.mjs` 注入的 Kotlin
//    监听 `WindowInsetsCompat` 后推送。
// 2. **`env(safe-area-inset-*)`** —— iOS / 支持它的浏览器；在 `:root` 里作为
//    CSS 变量的**兜底值**（见 App.css）。
//
// `--kb` 的语义是「**键盘额外盖住、而视口还没缩掉的那部分高度**」：
// 有些环境（浏览器 `interactive-widget=resizes-content`、某些 OEM 真的 resize 了窗口）
// 视口已经缩了，此时再按 IME inset 顶一次就**顶两遍**。所以：
//
//   --kb = max(0, 系统报的 IME 高度 − 视口已经缩掉的高度)
//
// 这条纯函数在 `viewportInsets.test.ts` 里钉住（含"不许重复计算"那一档）。

export interface ViewportInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
  /** 软键盘高度（`WindowInsetsCompat.Type.ime()` 的 bottom）。 */
  ime: number;
}

export const ZERO_INSETS: ViewportInsets = { top: 0, right: 0, bottom: 0, left: 0, ime: 0 };

/** `visualViewport` / `window` 里算"视口已经缩掉多少"所需的那几个数。 */
export interface KeyboardGeometry {
  innerHeight: number;
  visualHeight: number;
  visualOffsetTop: number;
}

/**
 * 纯函数：键盘**额外**盖住的高度（CSS px）。
 *
 * @param imeCssPx 系统报的 IME inset（CSS px）；无壳层报送时传 0。
 * @param g 当前视口几何。
 */
export function keyboardExtra(imeCssPx: number, g: KeyboardGeometry): number {
  if (!Number.isFinite(imeCssPx) || imeCssPx <= 0) return 0;
  const already = Math.max(0, g.innerHeight - g.visualHeight - g.visualOffsetTop);
  return Math.max(0, Math.round(imeCssPx - already));
}

/** 纯函数：inset + 键盘高度 → 要写进 `:root` 的 CSS 变量。 */
export function insetsToCssVars(
  insets: ViewportInsets,
  keyboard: number,
): Record<string, string> {
  const px = (v: number) => `${Math.max(0, Math.round(v * 100) / 100)}px`;
  return {
    "--sat": px(insets.top),
    "--sar": px(insets.right),
    "--sab": px(insets.bottom),
    "--sal": px(insets.left),
    "--kb": px(keyboard),
  };
}

/** 把 payload 收敛成合法数字（壳层传来的东西一律当不可信输入）。 */
export function normalizeInsets(raw: unknown): ViewportInsets {
  const o = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  return { top: num(o.top), right: num(o.right), bottom: num(o.bottom), left: num(o.left), ime: num(o.ime) };
}

export interface ViewportInsetsState {
  /** 壳层报上来的 inset；浏览器里恒为 0。 */
  insets: ViewportInsets;
  /** 算出来的 `--kb`（CSS px）。 */
  keyboard: number;
  /** 是否收到过壳层的报送（验收/诊断用）。 */
  native: boolean;
}

export const INSETS_BRIDGE_KEY = "__SHUYONOTE_INSETS__";
export const VIEWPORT_DEBUG_KEY = "__SHUYONOTE_VIEWPORT__";

let state: ViewportInsetsState = { insets: ZERO_INSETS, keyboard: 0, native: false };
let installed = false;

function readGeometry(win: Window): KeyboardGeometry {
  const vv = win.visualViewport;
  return {
    innerHeight: win.innerHeight,
    visualHeight: vv ? vv.height : win.innerHeight,
    visualOffsetTop: vv ? vv.offsetTop : 0,
  };
}

function paint(doc: Document, win: Window): void {
  const keyboard = keyboardExtra(state.insets.ime, readGeometry(win));
  state = { ...state, keyboard };
  const vars = insetsToCssVars(state.insets, keyboard);
  const root = doc.documentElement;
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
}

/**
 * 安装 inset 桥（幂等）。
 *
 * 只在**有壳层报送**时才会让变量非零：浏览器里 `__SHUYONOTE_INSETS__` 永远不被调用，
 * `:root` 里 `env()` 的兜底值原样生效，桌面/Web 行为**完全不变**。
 */
export function installViewportInsets(doc: Document = document, win: Window = window): () => void {
  if (installed) return () => {};
  installed = true;

  const bridge = (payload: unknown) => {
    state = { insets: normalizeInsets(payload), keyboard: state.keyboard, native: true };
    paint(doc, win);
  };
  (win as unknown as Record<string, unknown>)[INSETS_BRIDGE_KEY] = bridge;

  // 键盘弹出/收起时 `visualViewport` 会动（不动的那些环境下这一层是空转），
  // resize 则覆盖旋转、分屏、桌面窗口缩放。
  const onGeometry = () => paint(doc, win);
  win.addEventListener("resize", onGeometry);
  win.addEventListener("orientationchange", onGeometry);
  win.visualViewport?.addEventListener("resize", onGeometry);
  win.visualViewport?.addEventListener("scroll", onGeometry);

  // 诊断入口：真机验收脚本（CDP）读它，比读计算样式直观。
  (win as unknown as Record<string, unknown>)[VIEWPORT_DEBUG_KEY] = {
    get: () => ({ ...state }),
    set: (payload: unknown) => bridge(payload),
  };

  paint(doc, win);

  return () => {
    installed = false;
    win.removeEventListener("resize", onGeometry);
    win.removeEventListener("orientationchange", onGeometry);
    win.visualViewport?.removeEventListener("resize", onGeometry);
    win.visualViewport?.removeEventListener("scroll", onGeometry);
    delete (win as unknown as Record<string, unknown>)[INSETS_BRIDGE_KEY];
    delete (win as unknown as Record<string, unknown>)[VIEWPORT_DEBUG_KEY];
  };
}

/** 当前状态（验收脚本 / 测试用）。 */
export function viewportInsetsState(): ViewportInsetsState {
  return { ...state };
}
