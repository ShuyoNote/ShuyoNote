import { useEffect, useState } from "react";
import { useNotes } from "../store/notes";
import { useSpaceStore } from "../store/space";
import { useWindowChrome } from "../store/windowChrome";
import { isDesktopPlatform } from "../lib/platform";
import { api, type SyncProfile } from "../lib/api";
import { syncTagLabel, syncTagColor } from "../lib/syncTag";

// 自绘标题栏（B 方案）。仅桌面端渲染，Web 端没有窗口概念。
//
// 关键点：
// - 拖拽用 `data-tauri-drag-region`（Tauri 会同时接管双击最大化）。放在最外层
//   容器上，中间的标题文字也要带，否则拖不动那一片。
// - 按钮区必须**排除**拖拽属性，否则点击会被当成拖窗口。
// - 按钮顺序与图形沿用 Windows 习惯（最小化 / 最大化 / 关闭，关闭 hover 变红），
//   这样用户不用重新学。
export function TitleBar() {
  const custom = useWindowChrome((s) => s.custom);
  const currentId = useNotes((s) => s.currentId);
  const pages = useNotes((s) => s.pages);
  const spaces = useSpaceStore((s) => s.spaces);
  const activeSpaceId = useSpaceStore((s) => s.activeId);
  const [maximized, setMaximized] = useState(false);
  const [syncProfile, setSyncProfile] = useState<SyncProfile | null>(null);

  const desktop = isDesktopPlatform();

  // 当前空间的同步目标（换空间时重新取）。失败静默：顶栏没有同步芯片而已。
  useEffect(() => {
    if (!desktop || !custom || !activeSpaceId) {
      setSyncProfile(null);
      return;
    }
    let alive = true;
    api
      .listSyncProfiles()
      .then((list) => {
        if (alive) setSyncProfile(list.find((p) => p.ws_id === activeSpaceId) ?? null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [desktop, custom, activeSpaceId]);

  const spaceName = spaces.find((s) => s.id === activeSpaceId)?.name ?? "";
  const pageTitle = pages.find((p) => p.id === currentId)?.title?.trim();
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

  if (!desktop || !custom) return null;

  const run = async (action: "minimize" | "toggleMaximize" | "close") => {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const w = getCurrentWindow();
    if (action === "minimize") await w.minimize();
    else if (action === "toggleMaximize") await w.toggleMaximize();
    else await w.close();
  };

  return (
    <div className="titlebar" data-tauri-drag-region>
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
      {/* 同步状态搬到顶栏：自绘标题栏腾出来的这条空间总得有用处，顺带让侧栏
          少一行。颜色与侧栏空间行、同步面板共用 syncTag 的同一套编码。 */}
      {syncProfile?.server_url && (
        <div
          className="titlebar-sync"
          data-tauri-drag-region
          title={`同步目标：${syncProfile.server_url}`}
        >
          <span
            className="titlebar-sync-dot"
            style={{ background: syncTagColor(syncProfile.server_url) }}
          />
          <span className="titlebar-sync-text">{syncTagLabel(syncProfile.server_url)}</span>
        </div>
      )}
      {/* 按钮区不带 drag-region：否则点击会被当作拖动窗口 */}
      <div className="titlebar-actions">
        <button className="titlebar-btn" title="最小化" aria-label="最小化" onClick={() => void run("minimize")}>
          <svg viewBox="0 0 12 12" aria-hidden><rect x="2" y="5.5" width="8" height="1" fill="currentColor" /></svg>
        </button>
        <button
          className="titlebar-btn"
          title={maximized ? "向下还原" : "最大化"}
          aria-label={maximized ? "向下还原" : "最大化"}
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
          title="关闭"
          aria-label="关闭"
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
