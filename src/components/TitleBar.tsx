import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { PresenceBar } from "./PresenceBar";
import { useNotes } from "../store/notes";
import { useSpaceStore } from "../store/space";
import { useWindowChrome } from "../store/windowChrome";
import { useAuth } from "../store/auth";
import { isDesktopPlatform } from "../lib/platform";
import { api, type SyncProfile } from "../lib/api";
import { syncTagLabel, syncTagColor } from "../lib/syncTag";
// ⚠️ 2026-10-01（owner 三条界面方向之①）：**右侧工具条撤掉**，那四个入口 + 插件常驻入口
//    全部搬到这条标题栏上 ✓（⛔ 不是文字胶囊 ✗ —— owner 明确要**保持现有的图标样式** ✓）。
import { useRightPanel } from "../store/rightPanel";
import { usePlugins } from "../store/plugins";
import { usePluginViewStore } from "../store/pluginViews";
import { viewPlacement, viewPlacementKey } from "../lib/pluginViews";
import { SparkleIcon, CommentIcon, BellIcon, ListIcon, PanelIcon } from "./icons";

// 自绘标题栏（B 方案）。仅桌面端渲染，Web 端没有窗口概念。
//
// 关键点：
// - 拖拽用 `data-tauri-drag-region`（Tauri 会同时接管双击最大化）。放在最外层
//   容器上，中间的标题文字也要带，否则拖不动那一片。
// - 按钮区必须**排除**拖拽属性，否则点击会被当成拖窗口。
// - 按钮顺序与图形沿用 Windows 习惯（最小化 / 最大化 / 关闭，关闭 hover 变红），
//   这样用户不用重新学。
export function TitleBar() {
  const { t } = useTranslation();
  const custom = useWindowChrome((s) => s.custom);
  const currentId = useNotes((s) => s.currentId);
  const pages = useNotes((s) => s.pages);
  const spaces = useSpaceStore((s) => s.spaces);
  const activeSpaceId = useSpaceStore((s) => s.activeId);
  const [maximized, setMaximized] = useState(false);
  const [focused, setFocused] = useState(true);
  const [syncProfile, setSyncProfile] = useState<SyncProfile | null>(null);
  // ⚠️ 2026-10-01（owner 界面方向之①）：右侧那条竖向工具条**撤了** ✓ ⇒ 它的入口搬到标题栏，
  //    所以这里读的就是原来 `RightRail` 读的那几个 store ✓（互斥关系仍在 rightPanel 里 ✓）。
  const aiOpen = useRightPanel((s) => s.ai);
  const tocOpen = useRightPanel((s) => s.toc);
  const commentsOpen = useRightPanel((s) => s.comments);
  const commentsTab = useRightPanel((s) => s.commentsTab);
  const openAi = useRightPanel((s) => s.openAi);
  const openToc = useRightPanel((s) => s.openToc);
  const openComments = useRightPanel((s) => s.openComments);
  const pluginKey = useRightPanel((s) => s.plugin);
  const allPlugins = usePlugins((s) => s.plugins);
  /**
   * 「通知」那颗的未读数 ✓。
   *
   * ⚠️ **现在恒为 0** ✗ —— 通知中心（`NotificationCenter` ✓）的数据是"按频道未读"，
   * 而那条规格（`INV-IM-unread-is-per-channel` ✓）**还没落地** ⇒ **登记为已知缺口** ✓：
   * 等它落地时，把这里换成那个 store 的读数即可 ✓（⛔ 现在**不假造一个数** ✗，
   * 也不把"角标没数"糊成"通知功能好了" ✗）。
   */
  const unreadCount = 0;
  // 插件声明的**常驻面板**入口（`placement: "rail"` ✓）：order 上排在 owner 那四颗**之后** ✓
  //（owner 2026-10-01 拍板 ✓）。只有**启用中**的插件算数 ✓ —— 停用的插件入口不该还在 ✓。
  const railViews = useMemo(
    () =>
      allPlugins
        .filter((p) => p.enabled)
        .flatMap((p) =>
          (p.views ?? [])
            .filter((v) => viewPlacement(v) === "rail")
            .map((v) => ({ pluginId: p.id, pluginName: p.name, view: v, key: viewPlacementKey(p.id, v) })),
        ),
    [allPlugins],
  );
  // 登录/登出（auth store 的 authed 变化）也会影响同步目标，订阅它以便登录后
  // 标题栏同步胶囊即时出现，无需刷新页面。
  const authed = useAuth((s) => s.authed);

  const desktop = isDesktopPlatform();

  // 当前空间的同步目标（换空间 / 登录状态变化时重新拉取）。失败静默：顶栏没有同步芯片而已。
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
  }, [desktop, custom, activeSpaceId, authed]);

  const spaceName = spaces.find((s) => s.id === activeSpaceId)?.name ?? "";
  const pageTitle = pages.find((p) => p.id === currentId)?.title?.trim();

  // 预览层 / 弹层用 --titlebar-h 定位，好避开自绘标题栏。开启时设 32px，
  // 关闭（系统标题栏）时设 0，让弹层自动适应两种模式。
  useEffect(() => {
    const h = desktop && custom ? "32px" : "0px";
    document.documentElement.style.setProperty("--titlebar-h", h);
    return () => {
      // 卸载时恢复，避免残留旧值
      document.documentElement.style.setProperty("--titlebar-h", "0px");
    };
  }, [desktop, custom]);
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

  if (!desktop || !custom) return null;

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
      <PresenceBar />
      {/* 同步状态搬到顶栏：自绘标题栏腾出来的这条空间总得有用处，顺带让侧栏
          少一行。颜色与侧栏空间行、同步面板共用 syncTag 的同一套编码。 */}
      {syncProfile?.server_url && syncProfile?.token && (
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
      {/* ⚠️ 2026-10-01（owner 界面方向之①）：右侧那条竖向工具条撤掉 ⇒ 它的入口**搬到这一行** ✓；
          形态照 owner 纠正后的口径＝**保持现有的图标样式** ✓（⛔ 不做文字胶囊 ✗）。
          顺序＝owner 定的四颗（AI 助手／讨论／通知／目录 ✓）＋ 插件常驻入口（`placement: "rail"`）
          **排在其后** ✓（owner 2026-10-01 拍板 ✓，⛔ 不是丢掉那个能力 ✗）。
          ⚠️ 「通知」角标现在恒为 0（见上面 `unreadCount` 的说明 ✓）。 */}
      <div className="titlebar-tools">
        <button
          className={`titlebar-tool${aiOpen ? " is-on" : ""}`}
          title="AI 助手"
          aria-label="AI 助手"
          aria-pressed={aiOpen}
          onClick={() => openAi(!aiOpen)}
        >
          <SparkleIcon width={16} height={16} />
        </button>
        <button
          className={`titlebar-tool${commentsOpen && commentsTab === "comments" ? " is-on" : ""}`}
          title="讨论"
          aria-label="讨论"
          aria-pressed={commentsOpen && commentsTab === "comments"}
          onClick={() => openComments(!(commentsOpen && commentsTab === "comments"), "comments")}
        >
          <CommentIcon width={16} height={16} />
        </button>
        <button
          className={`titlebar-tool${commentsOpen && commentsTab === "notifications" ? " is-on" : ""}`}
          title="通知"
          aria-label="通知"
          aria-pressed={commentsOpen && commentsTab === "notifications"}
          onClick={() => openComments(!(commentsOpen && commentsTab === "notifications"), "notifications")}
        >
          <BellIcon width={16} height={16} />
          {unreadCount > 0 && <span className="titlebar-tool-badge">{unreadCount}</span>}
        </button>
        <button
          className={`titlebar-tool${tocOpen ? " is-on" : ""}`}
          title="目录"
          aria-label="目录"
          aria-pressed={tocOpen}
          onClick={() => openToc(!tocOpen)}
        >
          <ListIcon width={16} height={16} />
        </button>
        {railViews.map((rv) => {
          const active = pluginKey === rv.key;
          return (
            <button
              key={rv.key}
              className={`titlebar-tool${active ? " is-on" : ""}`}
              title={`${rv.view.title || rv.view.id}（插件「${rv.pluginName}」）`}
              aria-label={`插件面板：${rv.view.title || rv.view.id}`}
              aria-pressed={active}
              onClick={() => {
                // 再点一下收起（与上面四颗同一个手感 ✓）；收起也走 store 的关闭路径 ✓，
                // 否则"当前占用"会留着一个已经看不见的键 ✗。
                if (active) usePluginViewStore.getState().close();
                else usePluginViewStore.getState().open(rv.pluginId, rv.pluginName, rv.view);
              }}
            >
              <PanelIcon width={16} height={16} />
            </button>
          );
        })}
      </div>
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
