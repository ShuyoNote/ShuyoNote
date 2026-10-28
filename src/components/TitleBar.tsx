import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNotes } from "../store/notes";
import { useSpaceStore } from "../store/space";
import { useWindowChrome } from "../store/windowChrome";
import { isDesktopPlatform, isMacDesktopPlatform } from "../lib/platform";
import { api } from "../lib/api";
import { overlayDepth } from "../lib/overlayStack";
// ⚠️ 2026-10-01（owner 界面方向之①）：**右侧工具条撤掉** ⇒ 它的入口搬到这条标题栏上 ✓；
//    入口本身抽在 `TopTools` 里 ✓ —— 因为**手机上标题栏不渲染** ✓，而 owner 要求两端都有 ✓
//    （同一个组件在 `App.tsx` 的 `.app` 顶部再渲染一处 ✓，⛔ 不各写一份 ✗）。
import { TopTools } from "./TopTools";

// 自绘标题栏（B 方案）。仅桌面端渲染，Web 端没有窗口概念。
//
// 关键点：
// - 拖拽用 `data-tauri-drag-region`（Tauri 会同时接管双击最大化）。放在最外层
//   容器上，中间的标题文字也要带，否则拖不动那一片。
// - 按钮区必须**排除**拖拽属性，否则点击会被当成拖窗口。
// - 按钮顺序与图形沿用 Windows 习惯（最小化 / 最大化 / 关闭，关闭 hover 变红），
//   这样用户不用重新学。
// 自绘的 macOS 红绿灯（2026-10-23）。系统那三颗被 Rust 侧移到窗口外（尺寸改不了，
// 见 src-tauri/src/lib.rs 的 `traffic_light_position(-100,14)`），这里按 10px 重画：
// 比系统的小一号、间距更紧（owner 要"像微信那样"）。
// 行为对齐系统：平时是纯色点，鼠标进这一组才显 × − ⤢；失焦变灰；
// 点击＝关闭 / 最小化 / **全屏**（macOS 原生绿灯就是全屏，⛔ 不是缩放）；
// ⌥(Option)+点绿键 = 缩放（原生同款），双击顶部空白处 = 缩放（见下面 document 级 mousedown）。
// ⚠️ 2026-10-23 owner 反馈"最大化没有全屏" ⇒ 绿键从 `toggleMaximize` 改成 `setFullscreen`。
function MacLights() {
  const { t } = useTranslation();
  const run = (action: "close" | "minimize" | "toggleMaximize" | "toggleFullscreen") => {
    void (async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const w = getCurrentWindow();
      if (action === "close") await w.close();
      else if (action === "minimize") await w.minimize();
      else if (action === "toggleMaximize") await w.toggleMaximize();
      else await w.setFullscreen(!(await w.isFullscreen()));
    })();
  };
  return (
    <div className="mac-lights">
      <button
        className="mac-light mac-light-close"
        aria-label={t("common.close")}
        title={t("common.close")}
        onClick={() => run("close")}
      >
        <svg viewBox="0 0 6 6" aria-hidden>
          <path d="M1.2 1.2l3.6 3.6M4.8 1.2L1.2 4.8" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
        </svg>
      </button>
      <button
        className="mac-light mac-light-min"
        aria-label={t("common.minimize")}
        title={t("common.minimize")}
        onClick={() => run("minimize")}
      >
        <svg viewBox="0 0 6 6" aria-hidden>
          <path d="M1.2 3h3.6" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
        </svg>
      </button>
      {/* 与 macOS 原生一致：绿灯 = **全屏**（不是缩放）；⌥ 点是"缩放"。
          ⚠️ 2026-10-23 owner 反馈"最大化没有全屏" —— 原先这里走 `toggleMaximize`
          只放大到可视区域（菜单栏仍在），现在改成真正的全屏。 */}
      <button
        className="mac-light mac-light-zoom"
        aria-label={t("common.fullscreen")}
        title={t("common.fullscreen")}
        onClick={(e) => run(e.altKey ? "toggleMaximize" : "toggleFullscreen")}
      >
        <svg viewBox="0 0 6 6" aria-hidden>
          {/* macOS 的"缩放"字形：两个对角三角 */}
          <path d="M1.1 1.1h2.3L1.1 3.4z" fill="currentColor" />
          <path d="M4.9 4.9H2.6l2.3-2.3z" fill="currentColor" />
        </svg>
      </button>
    </div>
  );
}

export function TitleBar({ standalone = false }: { standalone?: boolean } = {}) {
  const { t } = useTranslation();
  const custom = useWindowChrome((s) => s.custom);
  const currentId = useNotes((s) => s.currentId);
  const pages = useNotes((s) => s.pages);
  const spaces = useSpaceStore((s) => s.spaces);
  const activeSpaceId = useSpaceStore((s) => s.activeId);
  const [maximized, setMaximized] = useState(false);
  const [focused, setFocused] = useState(true);

  const desktop = isDesktopPlatform();
  // ⭐ 2026-10-23：macOS 走原生透明标题栏（红绿灯浮在内容上，见 src-tauri/src/lib.rs）。
  //   那种形态下**没有**自绘栏，但要一条 drag-region 顶带（Overlay 下必须自己给，
  //   否则窗口拖不动）——所以下面提前 return 的分支对 macOS 不是 `null`。
  const macNative = isMacDesktopPlatform();
  const showsOwnBar = desktop && custom; // 自绘栏（Windows/Linux 默认关）
  // 浮层避让高度 `--titlebar-h`：
  //   · 自绘栏 32px；
  //   · macOS 主窗口 **0** —— 微信式布局里侧栏/主区内容顶到窗口顶，浮层也从 0 开始，
  //     红绿灯的让位由 `.is-macos` 的 `--mac-lights-h` 只作用在左竖条上；
  //   · macOS 独立页面窗口 28 —— 它没有左竖条，主区自己让位（`main:first-child`）。
  const nativeChromeH = desktop && !showsOwnBar && macNative ? (standalone ? 28 : 0) : 0;

  const spaceName = spaces.find((s) => s.id === activeSpaceId)?.name ?? "";
  const pageTitle = pages.find((p) => p.id === currentId)?.title?.trim();

  // 预览层 / 弹层用 --titlebar-h 定位，好避开顶部 chrome。三档：
  //   自绘栏 32px ／ macOS 原生透明标题栏 28px（红绿灯占位）／ 系统标题栏 0。
  //   ⚠️ macOS 那档的 28 与 CSS `.is-macos` 里给各列加的下移量**同源**（都读这个变量）。
  useEffect(() => {
    const h = showsOwnBar ? "32px" : `${nativeChromeH}px`;
    document.documentElement.style.setProperty("--titlebar-h", h);
    return () => {
      // 卸载时恢复，避免残留旧值
      document.documentElement.style.setProperty("--titlebar-h", "0px");
    };
  }, [showsOwnBar, nativeChromeH]);
  const label = [pageTitle || null, spaceName || null].filter(Boolean).join(" · ") || "ShuyoNote";

  // 同步到窗口标题：即使关掉自绘标题栏（用系统栏），也应显示「页面 · 空间」，
  // 而不是永远的产品名+版本号——开着几个独立页面窗口时那样根本分不清谁是谁。
  // 放在提前返回之前，两种模式下都会执行。
  useEffect(() => {
    if (!desktop) return;
    void (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await getCurrentWindow().setTitle(label);
      } catch {
        /* 标题设置失败不影响使用 */
      }
    })();
  }, [desktop, label]);

  useEffect(() => {
    if (!desktop || !custom) return;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const w = getCurrentWindow();
      setMaximized(await w.isMaximized());
      // 窗口尺寸变化时刷新「最大化/还原」图标，否则用系统方式（Win+↑、拖到
      // 顶部）改变状态后图标会与实际不符。
      unlisten = await w.onResized(async () => setMaximized(await w.isMaximized()));
    })();
    return () => unlisten?.();
  }, [desktop, custom]);

  // 失焦变淡：系统标题栏本来就有这个行为，自绘的若不做，多窗口时分不清
  // 哪个是当前窗口。
  useEffect(() => {
    if (!desktop || !custom) return;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const w = getCurrentWindow();
      setFocused(await w.isFocused());
      unlisten = await w.onFocusChanged(({ payload }) => setFocused(payload));
    })();
    return () => unlisten?.();
  }, [desktop, custom]);

  // ⭐ macOS（未开自绘栏）：不渲染任何 DOM，只把**整窗顶部 28px 的空白处**变成
  //   "拖窗 + 双击放大"区域（微信 / 系统应用的手感）。
  //
  //   为什么不在顶部铺一条 `div`：B 版布局里竖条顶端几乎被三颗红绿灯占满
  //   （灯 6..60，竖条 64）⇒ 一条 64px 宽的拖拽带只剩几像素可用，实测拖不动 ✗。
  //   改成 document 级 mousedown 判定，规则只有两条：
  //     ① `clientY <= 28`（与 `--mac-lights-h` 同一个数）且落在**非交互控件**上；
  //     ② 是交互控件（button / a / input / textarea / select / contenteditable /
  //        role=button / `[data-no-drag]`）⇒ 一律放行，绝不抢它的点击。
  //   ⚠️ **故意不用** `data-tauri-drag-region`：那个属性由 tauri 在 mousedown 里直接
  //      进原生拖动，会把"双击"吃掉（实测双击放大不触发 ✗）。
  //   ⚠️ 本 effect 必须在提前 return **之前**（`check-hook-order` 门禁）。
  useEffect(() => {
    if (!macNative || showsOwnBar) return;
    const INTERACTIVE =
      'button, a, input, textarea, select, [contenteditable="true"], [role="button"], [data-no-drag]';
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0 || e.defaultPrevented) return;
      if (document.documentElement.classList.contains("mac-fullscreen")) return;
      if (e.clientY > 28) return; // 只认顶部那条 chrome 高度
      const t = e.target as Element | null;
      if (t?.closest(INTERACTIVE)) return; // 控件优先：设置、切空间、顶栏工具都照常可点
      void (async () => {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const w = getCurrentWindow();
        if (e.detail === 2) await w.toggleMaximize(); // macOS 的「缩放」
        else await w.startDragging();
      })();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [macNative, showsOwnBar]);

  // macOS 自绘灯：失焦时整组变灰（系统行为）。挂在 <html> 上给 CSS 用。
  useEffect(() => {
    if (!macNative || showsOwnBar) return;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const w = getCurrentWindow();
      const syncFocus = (hasFocus: boolean) => {
        document.documentElement.classList.toggle("mac-blurred", !hasFocus);
      };
      // 全屏时系统标题栏整条都不在 ⇒ 自绘灯也得收起来，否则会浮在内容上。
      const syncFullscreen = async () => {
        document.documentElement.classList.toggle("mac-fullscreen", await w.isFullscreen());
      };
      syncFocus(await w.isFocused());
      await syncFullscreen();
      const offFocus = await w.onFocusChanged(({ payload }) => syncFocus(payload));
      const offResize = await w.onResized(() => void syncFullscreen());
      unlisten = () => {
        offFocus();
        offResize();
      };
    })();
    return () => {
      unlisten?.();
      document.documentElement.classList.remove("mac-blurred");
      document.documentElement.classList.remove("mac-fullscreen");
    };
  }, [macNative, showsOwnBar]);

  // 全屏下按 Esc 退出（与视频播放器一致的直觉；⛔ 有浮层时放行给浮层先关）。
  useEffect(() => {
    if (!macNative || showsOwnBar) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (!document.documentElement.classList.contains("mac-fullscreen")) return;
      if (overlayDepth() > 0) return;
      void (async () => {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await getCurrentWindow().setFullscreen(false);
      })();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [macNative, showsOwnBar]);

  if (!desktop) return null;
  if (!showsOwnBar) {
    // macOS：只渲染那三颗自绘灯（拖拽/双击由上面 document 级 mousedown 负责）。
    return macNative ? <MacLights /> : null;
  }
  const run = async (action: "minimize" | "toggleMaximize" | "close") => {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const w = getCurrentWindow();
    if (action === "minimize") await w.minimize();
    else if (action === "toggleMaximize") await w.toggleMaximize();
    else await w.close();
  };

  return (
    <div
      className={`titlebar${focused ? "" : " is-blurred"}`}
      data-tauri-drag-region
      onContextMenu={(e) => {
        // 右键标题栏唤出系统窗口菜单——无边框窗口丢掉的入口之一。
        // 不传 screenX/Y：前端是 DPI 缩放的逻辑像素，会错位；Rust 侧用
        // cursor_position() 取物理坐标，与 system menu 同坐标系。
        e.preventDefault();
        void api.showWindowMenu();
      }}
    >
      <div className="titlebar-brand" data-tauri-drag-region>
        <svg className="titlebar-logo" viewBox="0 0 1024 1024" aria-hidden>
          <rect x="0" y="0" width="1024" height="1024" rx="230" fill="currentColor" opacity="0.16" />
          <rect x="248" y="318" width="250" height="388" rx="42" fill="currentColor" />
          <rect x="526" y="318" width="250" height="388" rx="42" fill="currentColor" />
        </svg>
      </div>
      <div className="titlebar-title" data-tauri-drag-region title={label}>
        {label}
      </div>
      {/* ⚠️ 2026-10-01（owner 界面方向之①）：右侧那条竖向工具条撤掉 ⇒ 入口搬进**这一行** ✓
          （组件在 `TopTools.tsx` ✓ —— 手机上标题栏不渲染，所以 `App.tsx` 顶部另渲染一处 ✓，
          两处共用同一个组件 ✓，⛔ 不各写一份 ✗）。
          形态＝**保持图标样式** ✓（⛔ 不做文字胶囊 ✗）；顺序＝四颗 ＋ 插件常驻入口排其后 ✓。 */}
      <TopTools />
      {/* 按钮区不带 drag-region：否则点击会被当作拖动窗口 */}
      <div className="titlebar-actions">
        <button className="titlebar-btn" title={t("common.minimize")} aria-label={t("common.minimize")} onClick={() => void run("minimize")}>
          <svg viewBox="0 0 12 12" aria-hidden><rect x="2" y="5.5" width="8" height="1" fill="currentColor" /></svg>
        </button>
        <button
          className="titlebar-btn"
          title={maximized ? t("common.restore") : t("common.maximize")}
          aria-label={maximized ? t("common.restore") : t("common.maximize")}
          onClick={() => void run("toggleMaximize")}
        >
          {maximized ? (
            <svg viewBox="0 0 12 12" aria-hidden>
              <rect x="2" y="3.5" width="6" height="6" fill="none" stroke="currentColor" />
              <path d="M4 3.5V2h6v6H8.5" fill="none" stroke="currentColor" />
            </svg>
          ) : (
            <svg viewBox="0 0 12 12" aria-hidden>
              <rect x="2.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" />
            </svg>
          )}
        </button>
        <button
          className="titlebar-btn titlebar-close"
          title={t("common.close")}
          aria-label={t("common.close")}
          onClick={() => void run("close")}
        >
          <svg viewBox="0 0 12 12" aria-hidden>
            <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" fill="none" />
          </svg>
        </button>
      </div>
    </div>
  );
}
