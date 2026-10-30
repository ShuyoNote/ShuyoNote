import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLeaseAutoRefresh } from "./lib/license/useLeaseAutoRefresh";
import { hasBlockContent } from "./lib/blankPage";
import { isDesktopPlatform, isMacDesktopPlatform } from "./lib/platform";
import { PageTree } from "./components/PageTree";
import { SyncPanel } from "./components/SyncPanel";
import { ActivityBar } from "./components/ActivityBar";
import { TitleBar } from "./components/TitleBar";
// ⚠️ 2026-10-01（owner 界面方向之①）：右侧工具条撤掉，入口搬到**顶端工具栏** ✓；
//    而手机上 `TitleBar` 不渲染 ⇒ 这里要**自己渲染一行**（与桌面同一个组件 ✓：`TopTools` ✓）。
import { TopTools } from "./components/TopTools";
import { useWindowChrome, applyDecorations } from "./store/windowChrome";
import { BacklinksPanel } from "./components/BacklinksPanel";
import { UnlinkedMentionsPanel } from "./components/UnlinkedMentionsPanel";
import { AttachmentPanel } from "./components/AttachmentPanel";
import { PropertiesPanel } from "./components/PropertiesPanel";
import { DatabaseView } from "./components/DatabaseView";
import { TableOfContents } from "./components/TableOfContents";
import { NewPageGuide } from "./components/NewPageGuide";
import { CommandPalette } from "./components/CommandPalette";
// ⭐ 2026-10-10：移动端首页（效果图 01-home.svg，规格 §4.1）—— 只在 `isMobile` 且"什么都没打开"时渲染 ✓。
import { MobileHome } from "./components/MobileHome";
// ⭐ 2026-10-10：移动端「快速记录」（效果图 02-capture.svg，规格 §4.2）—— 同一支里的第二屏 ✓。
import { MobileCapture } from "./components/MobileCapture";
// ⭐ 2026-10-10：手机档的**阅读屏**（效果图 `docs/plans/mobile/mockups/04-read.svg`，规格 §4.4）——
//   只在 `isMobile && 有打开页` 时渲染 ✓；⛔ 桌面档仍走 `NoteEditor` ✓。
import { MobileRead } from "./components/MobileRead";
// ⭐ 2026-10-10：手机档的**「关于」屏**（效果图 `10-about.svg`，规格 §4.10）—— 沿用 `aboutOpen` ✓。
import { MobileAbout } from "./components/MobileAbout";
// ⭐ 2026-10-10：手机档的**搜索屏**（效果图 `03-search.svg`，规格 §4.3）—— 首页那张「搜索」卡进它 ✓。
import { MobileSearch } from "./components/MobileSearch";
// ⭐ 阶段 2（R205）：移动端**自己的设置屏**（原来屏在、门没有 ✗ ⇒ 现在由手机 ⚙️ 进 ✓）。
import { MobileSettings } from "./components/MobileSettings";
// ⭐ 第二刀（2026-10-19）：手机档**底边栏 ＋ 浮「＋」** —— 与删 ☰ / 删同步浮钮**同一笔** ✓
//   （只删 ☰ 不接底栏 ⇒ 设置/关于/设备配对全成死屏 ✗）。
import { MobileComposeFab, MobileTabBar } from "./components/MobileTabBar";
// ⭐ 2026-10-10：手机档的**「设备配对 · 同步」屏**（效果图 `08-pair.svg`，规格 §4.8）——
//   入口＝底栏「我的」设置屏里的 `<SyncPanel />` ✓（2026-10-19 第二刀从主界面浮钮搬过去 ✓；桌面档一个字不动 ✓）。
import { MobilePair } from "./components/MobilePair";
// ⭐ d1：移动端「首次配对」屏（骨架 ✓，对码未接 ✗）
import { MobilePairCode } from "./components/MobilePairCode";
import { useMobileNav } from "./store/mobileNav";
import { PluginViewOverlay } from "./components/PluginViewOverlay";
import { PluginViewPanel } from "./components/PluginViewPanel";
import { ShortcutsPanel } from "./components/ShortcutsPanel";
import { AboutDialog } from "./components/AboutDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { SpaceTransferProgress } from "./components/SpaceTransferProgress";
import { UpdateBanner } from "./components/UpdateBanner";
import { FilePreviewDialog } from "./components/FilePreviewDialog";
import { CommunitySaveDialog } from "./components/CommunitySaveDialog";
// ⭐ 2026-10-18（C 弹窗）：两个导出入口（导出当前页… / 导出本空间…）共用的那个浮层 ✓
import { MarkdownExportDialog } from "./components/MarkdownExportDialog";
import { PdfReader } from "./components/PdfReader";
import { FormulaEditorDialog } from "./components/FormulaEditorDialog";
import { CoverPicker } from "./components/CoverPicker";
import { Toaster } from "./components/Toaster";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { InputDialog } from "./components/InputDialog";
import { PluginManager } from "./components/PluginManager";
import { EditorToolbar } from "./components/EditorToolbar";
import { ConflictBanner } from "./components/ConflictBanner";
import { LineageConflictBanner } from "./components/LineageConflictBanner";
import { TextRepairRunner } from "./components/TextRepairRunner";
import { AiAssistantPanel } from "./components/AiAssistantPanel";
import { InlineAiDraftBar } from "./components/InlineAiDraftBar";
import { SmileIcon, ImageIcon } from "./components/icons";
import { TagAddButton } from "./components/TagBar";
import { LockScreen } from "./components/LockScreen";
import { useVault } from "./hooks/useVault";
import { EmojiPicker } from "./components/EmojiPicker";
import { useIconPicker } from "./store/iconPicker";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { PanelBoundary } from "./components/PanelBoundary";
import { Editor } from "./editor/Editor";
import { useSyncStream } from "./hooks/useSyncStream";
import { useSyncProgress } from "./hooks/useSyncProgress";
import { useExternalDrafts } from "./hooks/useExternalDrafts";
import { useMcpFrontendTools } from "./hooks/useMcpFrontendTools";
import { AUTO_SYNC_CHANGED_EVENT, effectiveAutoSyncMs, setLanMeshActive } from "./lib/syncMode";
import { shouldAutoSyncNow } from "./lib/syncGate";
// 空闲退避（2026-09-30）：自动同步那一轮的节拍判据（纯函数；三条口径与"兜底"都在那里 ✓）
import {
  decideHiddenTick,
  decideSyncTick,
  roundWasEmpty,
  type MeshLike,
  type SyncLike,
} from "./lib/syncBackoff";
// 切后台判据（2026-09-30）：**只停移动端** —— 平台口径复用仓里既有那个"是不是移动端"的判断 ✓
import { isMobileUserAgent } from "./lib/platform/capabilities";
// 「真·本地编辑」信号的**模块级广播**（S3b-1 那个实例级 `onLocalEdit` 的转发，见那个文件的注释）：
// 本笔的"改完就上传"要的正是这个信号，而会话实例由 `editor/Editor.tsx` 持有 ⇒ 只能从这一层拿。
import { onAnyLocalEdit } from "./lib/crdt/yDocBridge";
import { useMobile } from "./hooks/useMobile";
import { useGlobalShortcuts } from "./hooks/useGlobalShortcuts";
import { useScrollMemory } from "./hooks/useScrollMemory";
import { useUpdateChecker } from "./lib/useUpdateChecker";
import { api } from "./lib/api";
import { createDeepLinkHandler } from "./lib/deepLinkDispatch";
import { useNotes } from "./store/notes";
import { useSpaceStore } from "./store/space";
import { shouldDropPendingSave } from "./lib/pendingSave";
import { isLocalEditRecent, markLocalEdit } from "./lib/editIdle";
import { usePlugins } from "./store/plugins";
import { emitHostEvent } from "./lib/pluginEvents";
import { applyThemeTokens, resolveTheme } from "./lib/pluginTheme";
import { useActivity } from "./store/activity";
import { useCommunitySave } from "./store/communitySave";
import { mountDeepLinks } from "./lib/deepLinkBridge";
import { useEditorStore } from "./store/editor";
import { $createParagraphNode, $getRoot } from "lexical";
import { useBlockCache } from "./store/blockCache";
import { useViewStore } from "./store/view";
import { usePdfReader } from "./store/pdfReader";
import { useFilePreview } from "./store/filePreview";
import { pdfPlacement } from "./lib/pdfPlacement";
import { useFileManagerStore } from "./store/fileManager";
import { toast } from "./store/toast";
import { platform } from "./lib/platform";
import { withSyncStatus } from "./store/syncStatus";
import "./App.css";
// MCP 接入面板（跨空间支持矩阵改版）的专用样式：不写进 App.css（那条文件在收缩），
// 也不用内联样式 —— 全部收在独立文件里，放在 App.css **之后**以便覆盖同特异性的旧类。
import "./styles/mcp-panel.css";
import { OfficeImportPanel } from "./components/OfficeImportPanel";

// Secondary views are code-split so the initial bundle stays lean; they load only
// when the user switches to graph / board / files / template-center (the default
// editor page stays synchronous). Heavy libs (cytoscape, mermaid…) are also lazy.
const GraphView = lazy(() => import("./components/GraphView").then((m) => ({ default: m.GraphView })));
const TimelineReview = lazy(() => import("./components/TimelineReview").then((m) => ({ default: m.TimelineReview })));
const KnowledgeMap = lazy(() => import("./components/KnowledgeMap").then((m) => ({ default: m.KnowledgeMap })));
const BoardView = lazy(() => import("./components/BoardView").then((m) => ({ default: m.BoardView })));
const FileManagerView = lazy(() => import("./components/FileManagerView").then((m) => ({ default: m.FileManagerView })));
const TemplateCenterView = lazy(() => import("./components/TemplateCenterView").then((m) => ({ default: m.TemplateCenterView })));

function ViewLoader() {
  return <div className="view-loading" role="status">加载中…</div>;
}


// =====================================================================================
// ★ 2026-09-29（本笔）：**自动同步"唯一的那一轮"** —— 两个触发面共用它，不许各写一份。
//
// 两个触发面：
//   ① 自动同步定时器（`NoteEditor` 里那个 effect，按 `effectiveAutoSyncMs()` 的节拍）；
//   ② **正文上传触发**（本笔新增）：编辑器里一次**真·本地编辑** ⇒ 防抖 ⇒ 调它这一次。
//      它补的是"我改了 ⇒ 别人多久看到"那一半：在这之前 `syncWorkspace` 的调用点里
//      **没有一处**是"编辑器改完就调用它"（其余全是定时器 / 手动 / "收到服务端通知才拉"）。
//
// 三条纪律（与定时器那条**逐字同源**，因为现在就是同一段代码）：
//   · ① **必须过 C2 网络闸门**（`lib/syncGate.ts`，唯一一处实现）。本触发属于**自动**
//        （用户没点按钮）⇒ 必须过闸；手动点「同步」不走这里。
//   · ② **防重入**：上一轮还没跑完就**不并发起第二轮**（定时器那条在这里跳过；编辑触发那条
//        见 `requestAutoSyncRound`，它把那一轮**合并**成"跑完再来一次"）。
//   · ③ **失败静默**（与定时器一致：一次网络失败不该打断用户），**但留痕** ——
//       至少 `console.warn` 一次（`.catch(() => null)` 那种完全静默是既有形状，本笔不再加一处）。
//
// ⚠️ 为什么是模块级函数而不是组件里的闭包：两个触发面都在 `NoteEditor` 里，而 `busy` 必须是
//    **同一个**（②）。定时器那个 effect 会随 `autoSyncMs` 重挂 —— 闭包级的 `busy` 会跟着重置，
//    于是"换档那一刻"防重入就失效了。跨重挂的那个"一个"只能住在模块级
//    （先例：`syncMode.ts` 的 `lanMeshActive`，同一个理由）。
// =====================================================================================
let syncRoundBusy = false;
/** 忙的时候，"还得再跑一轮"这件事记在这里（见 `requestAutoSyncRound`）。 */
let syncRoundPending = false;
// ★ 空闲退避（2026-09-30）：**连续"这一轮什么都没换到"的次数** ＋ **上一次真跑的时刻**。
// ⚠️ 也住在模块级（与 `busy/pending` 同一个理由：必须跨 effect 重挂存活 ✓）。
// 口径、"硬顶/兜底"、以及"什么算空"都在 `lib/syncBackoff.ts` —— **这里不重复解释一遍 ✓**。
let syncEmptyStreak = 0;
let syncLastRunAtMs: number | null = null;

/**
 * 跑一轮自动同步（**唯一实现**）。两个触发面都走它。
 *
 * 形状与原先的 `tick` 逐句相同：防重入 → 闸门 → 每空间档案 → 有服务端地址的走服务端那条 ＋
 * 有 `space_id` 的顺手跑网格 → 刷新页面列表。
 */
async function runAutoSyncRound(): Promise<void> {
  if (syncRoundBusy) return;
  syncRoundBusy = true;
  try {
    // ① C2 网络闸门：**这条路也必须过闸**（真机验收发现它原先绕过了闸门检查
    // ——把面板间隔设成"每 10 秒"就会在蜂窝上照拉）。判据只有一处实现，见 `lib/syncGate.ts`。
    if (!(await shouldAutoSyncNow())) return;
    const profiles = await api.listSyncProfiles();
    // ⚠️ **服务端那条**：口径**逐字不变** —— 仍要求 `space_id` ＋ `server_url` ✓
    //（`space_id` 是"服务端给这个空间分配的 id"，⛔ 它**不是**"这个空间要不要同步"的判据 ✗）
    const bound = (profiles || []).filter((p: any) => p.space_id && p.server_url);
    let syncResults: SyncLike[] = [];
    if (bound.length) {
      // P1：**自动同步必须配对 begin/end**（`withSyncStatus` 保证），
      // 否则 Rust 侧的附件进度事件会把 store 置成"正在同步"且没人收尾，
      // 面板就永远停在"正在同步…"（真机实测过）。
      syncResults = await withSyncStatus("正在自动同步…", () =>
        Promise.all(
          bound.map((p: any) => api.syncWorkspace(p.ws_id).catch(() => null)),
        ),
      );
    }
    // ★ 网格（丙）：**每一份档案**都各跑一轮对等交换；失败不连坐（每条自己 `.catch`）。
    // ⚠️ "没配网格 ⇒ 一个字节都不动"这条 gate **只在 Rust 侧**（`mesh_sync_now` 自己早退）
    // ——前端**不重复判一遍**（两处各解释一遍迟早漂）。
    // ⚠️⚠️ **2026-10-09 修（真事故）**：这里原来写的是 `if (withSpace.length)` ✗，而 `withSpace`
    // 滤的是 `p.space_id` —— **个人空间的 `space_id` 就是空串** ✗（那正是 2026-10-08 那一整批修的口径）
    // ⇒ **个人空间＝"设备直连"的主用例**，却因为"没有服务端空间 id"被**整批滤掉** ✗
    // ⇒ 自动同步那条路**一个 `meshSyncNow` 都不发** ⇒ 网格**一次都不跑** ✗（用户只能手点面板才会同步）。
    // ⇒ 现在：**对每一份档案都发**，配没配由 Rust 侧那**一处**判 ✓（与上面同一句口径，不新增第二处判据 ✓）。
    const meshCandidates = profiles || [];
    let meshReports: MeshLike[] = [];
    if (meshCandidates.length) {
      meshReports = await Promise.all(meshCandidates.map((p: any) => api.meshSyncNow(p.ws_id).catch(() => null)));
      await useNotes.getState().loadPages();
    }
    // ★ 空闲退避（2026-09-30）：**跑完了才记时**（被闸门拦掉、或忙的时候不算"跑过" ✓）。
    //   口径（什么算"空"、出错怎么算）全在 `lib/syncBackoff.ts` —— 这里只喂两个数 ✓。
    const empty = roundWasEmpty(syncResults, meshReports);
    syncEmptyStreak = empty ? syncEmptyStreak + 1 : 0;
    // ⭐ 2026-10-24（owner 报「同步了没有自动刷新页面」）：这一轮**真的换到了东西** ⇒
    //   当前打开的页也要重读（`loadPages()` 只换列表；见 `notes.refreshCurrent`）。
    //   ⚠️ 正在打字时跳过：重挂编辑器会把你还没落库的那几百毫秒换掉（`lib/editIdle.ts`）。
    if (!empty && !isLocalEditRecent()) {
      await useNotes.getState().refreshCurrent();
    }
    syncLastRunAtMs = Date.now();
  } catch (e) {
    // ③ 自动同步失败静默（下次再试），**但留痕**（完全静默的话"改了没传上去"查不到因果）。
    console.warn("[sync] 自动同步这一轮失败（下一个节拍再试）", e);
  } finally {
    syncRoundBusy = false;
    if (syncRoundPending) {
      syncRoundPending = false;
      // 补上被合并掉的那一轮（**串行**，不是并发）。
      void runAutoSyncRound();
    }
  }
}

/**
 * 「编辑触发」那一侧的入口：忙 ⇒ **记下"跑完再来一次"**；闲 ⇒ 直接跑。
 *
 * 为什么不能像定时器那样"忙就丢掉"：编辑触发丢掉的不是"这一次节拍"，而是**某一笔改动**
 * 被推上去的唯一机会（下一轮要等一个节拍 —— 服务端档最长 5 分钟）⇒ 表现成
 * "我改了，对面半天没动"。所以这里**合并**（不许并发，见 `runAutoSyncRound` 的 ②）。
 */
function requestAutoSyncRound(): void {
  // ★ 空闲退避（2026-09-30）：**有人改 ⇒ 立刻回到基础节拍** ✓
  //   这就是"活跃时不牺牲延迟"那一半：输入/编辑一类动作一到，退避清零。
  syncEmptyStreak = 0;
  if (syncRoundBusy) {
    syncRoundPending = true;
    return;
  }
  void runAutoSyncRound();
}

/**
 * 一次本地编辑之后，隔多久真的去上传（**防抖窗口**）。
 *
 * 400ms：落在需求 §9.3 给的 300~500ms 区间里，取偏大的一侧，理由是它要盖住一次连续输入
 * （打字时 Lexical 每个批次都会报一次 `onLocalEdit`），同时不让"停手之后多久对面能看到"
 * 明显变慢（延迟拆解见需求 §9.5：防抖 ＋ 上传 ＋ 广播 ≈ 0.4~1 秒）。
 */
const LOCAL_EDIT_UPLOAD_DEBOUNCE_MS = 400;

function NoteEditor({ pageId }: { pageId: string }) {
  // 逐字段订阅：这 5 个 state 字段都真的进了渲染（正文 / 错误角标 / 搜索高亮 / 页面树 / 编辑器重挂载 key），
  // 而 `updateCurrent`/`loadPages` 是动作（引用恒定 ⇒ 选择器不产生额外重渲染）。
  // 原先的整店订阅会让本组件被 `currentId`/`loading` 等字段的变化一并唤醒（`loading` 每次
  // loadPages 都会翻转）。
  const current = useNotes((s) => s.current);
  const error = useNotes((s) => s.error);
  const searchQuery = useNotes((s) => s.searchQuery);
  const pages = useNotes((s) => s.pages);
  const reloadTick = useNotes((s) => s.reloadTick);
  const updateCurrent = useNotes((s) => s.updateCurrent);
  const loadPages = useNotes((s) => s.loadPages);
  const [title, setTitle] = useState(current?.title ?? "");
  const [saved, setSaved] = useState(true);
  const [coverOpen, setCoverOpen] = useState(false);
  const [coverH, setCoverH] = useState<number | null>(null);
  const coverHRef = useRef(300);
  const coverDrag = useRef<{ sy: number; sh: number } | null>(null);
  // 题头图上下拖动定位（背景位置 y，0-100%）。
  const [coverPos, setCoverPos] = useState<number | null>(null);
  const coverPosRef = useRef(50);
  const coverPosDrag = useRef<{ sy: number; sp: number; moved: boolean } | null>(null);
  const debounceRef = useRef<number | null>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  // ⚠️ 2026-10-06（owner）：「刷新页面，当前页面位置丢失了」⇒ 记住**每页的滚动位置**并在回到这一页时
  //    恢复。容器是下面那个 `.note-scroll`（应用自绘的一列，`document` 本身不滚 => 浏览器的
  //    `history.scrollRestoration` 管不到它 ✗）⇒ 自己记。存取那一半见 `lib/scrollMemory.ts` ✓。
  const scrollRef = useRef<HTMLDivElement>(null);
  // ⚠️ 第三个参数是"**这一页的详情到位了没**"——判据必须是 `current.id === pageId` ✓：
  //    光看 `!!current` 不够 —— 刷新/切页的一瞬间 `current` 还可能是**上一页**（或首屏那个），
  //    那时 `.note-scroll` 里根本没有这一页的内容，恢复会落在"当时的最大高度"上然后再也不重试 ✗
  //    （本机实测：600 被夹成 524 且不再动）。
  useScrollMemory(scrollRef, pageId || null, !!pageId && current?.id === pageId);

  // 自适应高度：标题超长时自动换行，而不是被截断。
  useEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [title]);

  // Build breadcrumb trail from the page tree.
  const breadcrumbs = useMemo(() => {
    const chain: { id: string; title: string; kind: string }[] = [];
    const map = new Map(pages.map((p) => [p.id, p]));
    let cur = map.get(pageId);
    const visited = new Set<string>();
    while (cur && cur.parent_id && !visited.has(cur.id)) {
      visited.add(cur.id);
      const parent = map.get(cur.parent_id);
      if (parent) {
        chain.unshift({ id: parent.id, title: parent.title || "未命名", kind: parent.kind });
        cur = parent;
      } else {
        break;
      }
    }
    return chain;
  }, [pages, pageId]);

  const openPage = (id: string) => {
    useNotes.getState().openPage(id);
  };

  // Sync local state when switching pages.
  useEffect(() => {
    setTitle(current?.title ?? "");
    setSaved(true);
  }, [pageId]);

  // Web: surface persistence failures so the user knows recent changes may not
  // be on disk (in-memory state is kept; we only make the failure visible).
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void platform.event
      .listen<{ error: string }>("persist-error", () => {
        toast("保存失败，更改可能未落盘", "error");
      })
      .then((u) => {
        unlisten = u;
      });
    return () => unlisten?.();
  }, []);

  // ⭐ 2026-10-24（真机：页 B 同页并发后两边各缺一块）：**网格那条路没有 SSE** ——
  //   Rust 后台轮把远端页并进库之后，前端完全不知道；编辑器里那份旧 doc 之后一保存，
  //   就把刚并进来的块盖掉。这里收到 `mesh-applied` 就刷列表 ＋ 刷新当前页（节流同自动同步那一轮）。
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void platform.event
      .listen<{ spaceId: string; pages: string[] }>("mesh-applied", () => {
        void useNotes.getState().loadPages();
        if (!isLocalEditRecent()) void useNotes.getState().refreshCurrent();
      })
      .then((u) => {
        unlisten = u;
      });
    return () => unlisten?.();
  }, []);

  // ⭐ 2026-10-28（owner 报「同步后空间列表没有自动刷新」）：**新空间要重读侧栏** ✗ ——
  //   Rust 的自动建空间发生在 `round` **之前**，所以 `mesh-applied` 那一批页里没有它
  //   （那条监听只刷页列表/当前页）⇒ 侧栏一直停在旧清单，要切空间/重启才看见新空间 ✓。
  //   后端在"这一轮真的新建了空间"时单独发一格 `spaces-changed`；这里只做一件事：重读清单 ✓。
  //   ⚠️ 重读失败只影响"侧栏这一秒显示什么"，不影响同步本身（`load()` 自己 catch 掉 ✓）。
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void platform.event
      .listen<{ created: string[] }>("spaces-changed", () => {
        void useSpaceStore.getState().load();
      })
      .then((u) => {
        unlisten = u;
      });
    return () => unlisten?.();
  }, []);

  // Restore the team-edition login state on startup (from meta.db session).
  useEffect(() => {
  }, []);

  // `shuyonote://` 的投递：把"操作系统交给应用的那条 URL"送进应用内接入缝。
  //
  // 这两行是整条深链的**最后一厘米**：Rust 侧（`src-tauri/src/deeplink.rs`）负责
  // 注册 scheme、被唤起、已有实例转发；`mountDeepLinks` 负责把 URL 搬进来；
  // 判断"这是什么动作、要不要预览"由接入缝自己做（`openWithLink`，语义层）。
  //
  // ⚠️ **不能只写"听事件"这一半**：冷启动那条 URL 的事件在前端挂载之前就发过了
  // （主窗口 `visible(false)`，插件 setup 时 emit）。只订阅会稳定漏掉**第一次**深链，
  // 而第二次正常——那种"第一次不灵"最容易被当成偶发。`mountDeepLinks` 里
  // "先订阅、再 drain 队列"两件事一起做，就是为了盖住这个洞。
  // 深链进来之后**先分派**再决定去哪：`page/` 打开那一页、`save`/`import` 交给社区对话框、
  // `compose` 如实说还没做。直接接到对话框上会把应用**自己生成的**页面链接也送进对话框
  // （那是一条有效链接，接错了动作）。分派逻辑是纯的，见 `deepLinkDispatch.ts`。
  useEffect(
    () =>
      mountDeepLinks(
        createDeepLinkHandler({
          openPage: (id) => useNotes.getState().openPage(id),
          openCommunityDialog: (url) => useCommunitySave.getState().openWithLink(url),
          notify: (message) => toast(message, "info"),
          // 测试钩子（只在 VITE_TEST_HOOKS=1 的构建里会真的被调用，见 deepLinkDispatch）。
          // 两者都走**与界面完全相同**的那条路：插件命令经 usePlugins.runCommand（权限与写中介
          // 原样成立），建页经 useNotes.createPage。钩子不绕过任何检查。
          runPluginCommand: async (pluginId, commandId, argsJson) =>
            usePlugins.getState().runCommand(pluginId, commandId, null, argsJson ?? undefined),
          createPageWithText: async (text) => {
            // 动态 import：这条路只在测试钩子里走，不该把 markdown→Lexical 的转换器
            // 拉进首屏包（App.tsx 里重的东西都这么处理）。
            const { markdownToPageContent } = await import("./lib/mdPreview");
            const payload = markdownToPageContent(text);
            if (!payload) throw new Error("这段文本转不成页面内容");
            return useNotes.getState().createPage(null, {
              title: text.split("\n")[0].slice(0, 24) || "测试钩子",
              content_json: payload.content_json,
              content_text: payload.content_text,
            });
          },
          // 测试钩子 http-probe：让 **Rust 侧**发一次真实 HTTPS（走 reqwest），
          // 用来验 Android 上系统证书库那条路通不通（见 docs/MOBILE.md §2.4）。
          //
          // 用 `fetch_bookmark_metadata`：它**接受任意 https 地址**并返回网页元数据（含标题），
          // 所以能看到**成功**路径（拿到标题），而不是只有一句错误。都是现成命令，
          // 不新增命令、不动能力清单。
          // ⚠️ 别换成 `fetch_community_json`：它只认 `community.shuyo.cn` 一个域名，
          // 而那个域名下随便挑的地址会返回 404 ⇒ 只能看到"失败"，证明不了握手成功。
          httpProbe: async (url) => JSON.stringify(await api.fetchBookmarkMetadata(url)),
          // Phase 0 持久化判据的程序化说法：重启后问一次"库里有哪些页"。
          // 为什么要这个钩子：重启后应用**总是停在空白新页**上，从界面看不出旧页在不在。
          listPages: () => api.listPages(),
          // 测试钩子 pick-file：与附件面板**同一对调用**（选择器 → 附件导入），
          // 用来在真机上验「选文件拿不到可读路径」那条修复（见 docs/MOBILE.md §2.2）。
          openFileDialog: () => platform.dialog.open({ multiple: false, directory: false }),
          importAttachments: (paths) => api.importAttachmentFiles(null, paths),
        }),
      ),
    [],
  );

  // 窗口是以无边框创建的（自绘标题栏）。若用户关掉了这个设置，启动时把系统
  // 标题栏恢复回来——设置存在 localStorage，Rust 侧读不到，只能前端补一刀。
  useEffect(() => {
    void applyDecorations(useWindowChrome.getState().custom);
  }, []);

  // 启动时应用 Mica 材质设置（默认关）；并重刷一次染色，保证与材料状态一致。
  useEffect(() => {
    void (async () => {
      const { api } = await import("./lib/api");
      await api.setMicaEffect(useWindowChrome.getState().material);
      const { syncTitlebarColors } = await import("./store/theme");
      syncTitlebarColors();
    })().catch(() => {});
  }, []);

  const pendingSaveRef = useRef<{
    pageId: string;
    patch: { title?: string; content_json?: string; content_text?: string };
  } | null>(null);

  /**
   * 把 pending 的那一次保存**立刻落库**（不等 600ms 去抖）。
   *
   * 三个调用点**共用这一处实现**（各写一份的下场是漂 —— 这一笔把原先写在卸载 effect 里的
   * 那一遍 `api.savePage(...)` 收进来了）：
   *   ① `persist` 的去抖到点；
   *   ② 卸载 / 换视图时的那条 flush（不许把用户刚敲的内容丢在去抖窗口里）；
   *   ③ ★ 新触发（`onAnyLocalEdit` ⇒ 防抖 ⇒ **先 flush 再上传**）。
   *
   * ③ 为什么必须先 flush：带 CRDT 状态的那条 outbox 记录是**页面保存那一刻**才产生的
   * （`save_page` → `record_page_upsert` 顺手读状态；只写状态的那条命令**不产**记录），
   * 而"编辑 ⇒ 页面保存"之间还有 600ms 去抖。⇒ 编辑之后直接按 300~500ms 去上传，会**赶在
   * 那条记录存在之前**跑一轮，那一轮推不动任何东西；而下一轮要等一个节拍（服务端档最长 5 分钟）。
   */
  const flushPendingSave = useCallback(async () => {
    const p0 = pendingSaveRef.current;
    // ⭐ R150：外部刚写过这一页 ⇒ 这条待保存的**内容已经旧了** ✗，丢掉 ✓
    //   （不丢的话，它到点落库就把外部那份盖回去 —— 现场三次读数都在 +0.4 秒 ✓）。
    if (
      p0 &&
      shouldDropPendingSave(p0, useNotes.getState().lastExternalWrite, Date.now())
    ) {
      pendingSaveRef.current = null;
      if (debounceRef.current) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      return;
    }
    const p = pendingSaveRef.current;
    pendingSaveRef.current = null;
    // 顺手撤掉那个还没到点的去抖定时器：flush 的语义是"现在写"，不是"再写一次"。
    if (debounceRef.current) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    if (!p) return;
    try {
      const updated = await api.savePage({ id: p.pageId, ...p.patch });
      updateCurrent(updated);
      setSaved(true);
      // 保存只可能改动 PageMeta 里的少数几个字段（标题 / `updated_at`）⇒ **就地更新列表
      // 那一条**，不再 `loadPages()` 全量重拉：后者会 `set(loading)` + `set(pages)` 两次
      // 全量广播，并为一次标题改动重查整张 page 表——而这条路每 600ms 就可能走一次，
      // `pages` 的订阅者里还有「每个树节点一个」的 TreeItem 与 DatabaseView 这种千行组件。
      // 三种情况回退到全量重拉，保证不漏：① 后端没回页面；② 本地列表里没有这一条
      // （例如刚在别处新建）；③ 列表上次加载就失败了 —— 顺便重试并清掉那个 `error` 角标
      // （旧代码每次都靠 loadPages() 顺手清，走近路时必须显式保留这个语义）。
      const notes = useNotes.getState();
      if (!updated || notes.error || !notes.patchPageMeta(updated)) loadPages();
      // Invalidate block-reference/embed caches so mirrors refresh.
      useBlockCache.getState().bump();
      // 保存后派发事件（M11.8）：只有**声明订阅了 page.saved** 的启用插件会收到。
      // 不 await：保存路径不该等插件；插件产出的写操作仍要用户确认才落库。
      void usePlugins.getState().emitEvent("page.saved", {
        pageId: p.pageId,
        title: updated?.title ?? "",
      });
    } catch (e) {
      console.error("save failed", e);
      toast(`保存失败：${e}`, "error");
    } finally {
      // Never leave the "保存中…" indicator stuck (e.g. a failed save).
      setSaved(true);
    }
  }, [loadPages, updateCurrent]);

  const persist = (patch: {
    title?: string;
    content_json?: string;
    content_text?: string;
  }) => {
    setSaved(false);
    pendingSaveRef.current = { pageId, patch };
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = null;
      void flushPendingSave();
    }, 600);
  };

  const onTitleChange = (value: string) => {
    setTitle(value);
    persist({ title: value });
  };

  // 标题回车 → 进入正文编辑：把光标落到正文里（无正文时自动补一个段落）。
  // title 是 textarea（自动换行），Enter 不插入换行、改为聚焦正文。
  const onTitleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const ed = useEditorStore.getState().editor;
    if (!ed) return;
    ed.update(() => {
      const root = $getRoot();
      if (!root.getFirstChild()) root.append($createParagraphNode());
    });
    ed.focus(undefined, { defaultSelection: "rootEnd" });
  };

  const onEditorSave = (json: string, text: string) => {
    persist({ content_json: json, content_text: text });
  };

  // Flush a pending save on unmount / page switch instead of dropping it, so
  // imported/edited content is never lost to the debounce (e.g. switching view
  // or closing the app within the 600ms window).
  useEffect(() => {
    return () => {
      // ⚠️ 与去抖到点是**同一条路**（`flushPendingSave`）：这里原先自己写了一遍
      //    `api.savePage(...)`，与去抖那一份是同一段逻辑的两个副本。
      // ⚠️ 依赖 `[]` + 那个 `useCallback` 的引用恒定（它只用 ref 与稳定的 store 动作）
      //    ⇒ 卸载时拿到的就是最新那一份，不会漏掉后写入的 pending。
      void flushPendingSave();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 主题插件：启用中的插件声明的设计变量应用到界面上；停用即移除（见 lib/pluginTheme）。
  // 解析规则（白名单 + 单赢家 + 冲突报出）在纯函数里，有单测。
  const themePlugins = usePlugins((s) => s.plugins);
  const appliedThemeRef = useRef<Record<string, string>>({});
  useEffect(() => {
    const { tokens } = resolveTheme(themePlugins);
    applyThemeTokens(tokens, appliedThemeRef.current);
    appliedThemeRef.current = tokens;
  }, [themePlugins]);

  // 启动时加载一次插件列表：事件派发要判断"有没有订阅者"，列表为空会让所有事件静默丢失。
  // 加载完再播报 app.started（顺序有意：插件得先被认出来，才能收到启动事件）。
  useEffect(() => {
    void usePlugins
      .getState()
      .load()
      .then(() => emitHostEvent("app.started", {}));
  }, []);

  // 自动同步：**只有这一条路**（2026-09-26 口径收敛）。
  //
  // · 间隔来自 SyncPanel（localStorage `shuyonote:autoSync`）：`0` ＝ 关；
  // · **启动后 3 秒先跑一次**（`0` 也跑）—— 这是原 `useAutoSync` 的行为，现在并进这里；
  // · 每轮对**每个有 `space_id` 的空间**：走服务端那条（`syncWorkspace`）＋ **顺手跑一轮网格**
  //   （`meshSyncNow`）。⚠️ "没配网格 ⇒ 一个字节都不动"这条 gate **只在 Rust 侧**
  //   （`mesh_sync_now` 自己早退）—— 前端**不重复判一遍**（两处各解释一遍迟早漂）。
  //   ⚠️ 网格那一条**不要求 `server_url`**："只开网格、不绑服务端"正是丙要支持的配置。
  // · 网络闸门 `shouldAutoSyncNow()` 一处实现（`lib/syncGate.ts`）。
  // · 防重入：上一次还没结束就跳过本次 tick。
  //
  // ⚠️ **为什么把 `useAutoSync` 删了**：它自带一条**固定 5 分钟**、且走**老的全局配置**
  // （`api.syncNow()`）的循环，与这条"按面板间隔、按每空间档案"的路并行 ⇒ 同一个用户两份间隔、
  // 两套语义、还会互相叠加（`syncGate.ts` 当初就写着"两条路各写一份判断也迟早会漂"，这次把路合成一条）。
  // ★ 2026-09-26（口径对齐）：这里读的是 **`effectiveAutoSyncMs()`**、不是 `readAutoSyncMs()`。
  //   理由：有效间隔是 `f(间隔档位, 近实时开关)` 两个键的函数，而"近实时"**默认就开着** ——
  //   从来没人动过下拉框的机器上，间隔那个键一个字都没写(=0) ⇒ 读裸值会让定时器**不挂**，
  //   而面板显示的是「近实时」＋承诺"连不上时退回每 5 分钟兜底一次"（真机实测抓到的口径不一致）。
  const [autoSyncMs, setAutoSyncMs] = useState(() => effectiveAutoSyncMs());
  // 面板改了「同步方式」⇒ 它会广播（`writeAutoSyncMs` / `broadcastAutoSyncChanged`）⇒ 这里跟一下，
  // 定时器才会按新档位重挂。
  // ⚠️ 没有这一步的话：面板改档 → App 不重渲染 → 定时器还按**老**间隔跑（"我选了按间隔，可它没动"）。
  useEffect(() => {
    const onChanged = () => setAutoSyncMs(effectiveAutoSyncMs());
    window.addEventListener(AUTO_SYNC_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(AUTO_SYNC_CHANGED_EVENT, onChanged);
  }, []);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    // ★ 用户**换档**（或本 effect 重挂）⇒ 退避清零：他刚表达过"我要这个节拍"，
    //   不该被上一次的空转历史拖住（否则"我选了 5 秒，它却 60 秒才跑" ⇒ 看着像坏了 ✗）。
    syncEmptyStreak = 0;
    // ⚠️ 这一轮的全部内容（防重入 / 闸门 / 两条路 / 刷新列表）搬到了模块级的
    //    `runAutoSyncRound` —— 现在**两个触发面共用它**（定时器 ＋ 编辑触发，见下）。
    //    `busy` 也跟着搬走了（它必须跨这个 effect 的重挂存活，否则换档那一刻防重入会失效）。
    //
    // ★ 空闲退避（2026-09-30）：原来是**固定** `setInterval(tick, autoSyncMs)` ⇒ 闲着也照跑
    //   （5 秒一次空轮询 ＝ 256 B，实测见 `_workspace/notes/2026-09-30-b1-b2-prechecks-macos.md`）。
    //   现在改成**自排程**：每跑完一轮按 `decideSyncTick` 算下一跳。
    //   ⚠️ 判据（含"什么算空"和**硬顶 60 秒那条无条件兜底**）**全在 `lib/syncBackoff.ts`** ✓。
    const schedule = (delayMs: number) => {
      if (cancelled || autoSyncMs <= 0) return;
      timer = setTimeout(() => void tick(), delayMs);
    };
    // ★ 切后台（2026-09-30）：**只停移动端** —— 判据在 `lib/syncBackoff.ts` 的 `decideHiddenTick`。
    //   ⚠️ 桌面端"窗口被挡住/最小化"**照跑**（那 ≠ 用户走了 ✓）；拿 hidden 一刀切会砍错人 ✗。
    const isMobile = isMobileUserAgent(navigator.userAgent);
    let hidden = document.visibilityState === "hidden";
    async function tick() {
      // 移动端在后台 ⇒ 不跑，而且**不再排下一跳**（循环就地停住）；
      // 回到前台由下面那个监听**立刻补一轮**唤醒 ✓（比"被系统冻在半路、回来还要等一个节拍"好 ✓）。
      if (!decideHiddenTick({ hidden, isMobile }).run) return;
      await runAutoSyncRound();
      const d = decideSyncTick({
        nowMs: Date.now(),
        lastRunAtMs: syncLastRunAtMs,
        baseMs: autoSyncMs,
        emptyStreak: syncEmptyStreak,
      });
      // ⚠️ `waitMs ≤ 0` 只可能是"这一轮**早退了**"（忙 / 被闸门拦掉 ⇒ 没记时）
      //    ⇒ 按基础节拍再来一次，**别原地空转** ✗（真跑过的那一轮 lastRunAt 刚更新，不会 ≤0 ✓）。
      schedule(d.waitMs > 0 ? d.waitMs : autoSyncMs);
    }
    // 回到前台 ⇒ **立刻补一轮**（用户一回来就看到最新的 ✓）＋ 退避清零。
    const onVisibility = () => {
      const wasHidden = hidden;
      hidden = document.visibilityState === "hidden";
      if (wasHidden && !hidden) {
        syncEmptyStreak = 0;
        void tick();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    // 启动后先来一次（与原来那条路一致：不管间隔设没设都跑）。
    // ⚠️ 这一行**故意保持原样**（函数名仍叫 `tick`、形状仍是 `setTimeout(tick, 3000)`）：
    //    `useSyncStream.wiring.test.ts:144` 那条接线判据钉的就是它，原意是
    //    「轮询必须**无条件**挂在 App 上（启动后先跑一次，与间隔设没设无关）」——
    //    本笔只改了**后续节拍怎么排**，这条原意**一字未动** ✓（所以判据也不该改 ✓）。
    timer = setTimeout(tick, 3000);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, loadPages, autoSyncMs]);

  /**
   * ★ 2026-09-29（本笔）：**正文上传触发** —— 「编辑器改了 ⇒ 防抖 ⇒ 立刻上传」。
   *
   * 补的是需求 §9.1 那一半：**下载侧**早就实时（服务端推一帧 ⇒ `useSyncStream` 立刻拉一次），
   * 而**上传侧**在 `syncWorkspace` 的调用点里**没有一处**是"编辑器改完就调用它" ——
   * 于是"我改了 ⇒ 别人多久看到"仍然是那个节拍（服务端档默认 5 分钟兜底）。
   *
   * 四条口径（与那一笔的要求逐条对应）：
   *   ① 信号源**不是新造的**：`onAnyLocalEdit` 就是 S3b-1 那个 `onLocalEdit` 的模块级广播，
   *      它**已经**区分"程序性写入（建血统 / 载入 / 远端合并落回编辑器）"与"用户编辑"，
   *      前者不报 ⇒ 不会把合并当成本机改动推回去；
   *   ② 跑的还是**同一个** `runAutoSyncRound`（**不新造第二条同步路**）；
   *   ③ 闸门、防重入、失败留痕都在 `runAutoSyncRound` 那一处（见它的注释）；
   *   ④ 卸载 / **换页**（`pageId` 变）⇒ 退订 ＋ 清掉 pending 的防抖定时器（**不许泄漏**）。
   *
   * ⚠️ 两个容易漏掉的次序：
   *   · **先 flush 再跑**：带状态的那条 outbox 记录是页面保存那一刻才产生的（理由写在
   *     `flushPendingSave` 的注释里）—— 否则这一轮推的还是上一版；
   *   · **「关闭」档不跑**：`effectiveAutoSyncMs() === 0`（＝同步方式选了「关闭」，且没开近实时）
   *     时**一个字都不自动跑** —— 这是 `syncMode.ts` 里写死的口径（"总闸优先"），
   *     本触发属于自动，**没有资格绕过总闸**（用户选的是"只有点「同步」时才同步"）。
   */
  useEffect(() => {
    let pending: ReturnType<typeof setTimeout> | undefined;
    const off = onAnyLocalEdit(() => {
      // ⭐ 2026-10-24：记下"刚刚真的在敲" —— 同步回来时用它决定要不要自动重挂当前页
      //   （见 `lib/editIdle.ts`；只在最近没编辑时才自动刷）。
      markLocalEdit();
      if (pending) clearTimeout(pending);
      pending = setTimeout(() => {
        pending = undefined;
        void (async () => {
          if (effectiveAutoSyncMs() <= 0) return;
          // 先把这一笔保存落到库里 —— 上传要推的那条记录是保存那一刻才产生的。
          await flushPendingSave();
          requestAutoSyncRound();
        })();
      }, LOCAL_EDIT_UPLOAD_DEBOUNCE_MS);
    });
    return () => {
      off();
      if (pending) clearTimeout(pending);
      pending = undefined;
    };
  }, [pageId, flushPendingSave]);

  // ⭐ 2026-10-11（owner 截图「去掉这部分」）：原先这里有一条「自动备份提醒」——
  //    读 `localStorage["shuyonote:backupReminder"]` ⇒ 距上次备份超过设定天数就在启动时弹一句 ✓。
  //    ⭐ 已连同设置里那一节一起**删掉** ✓ —— ⛔ 只删界面不删这里的话，用户会**继续被提醒却没法关** ✗。
  //    ⚠️ **如实记**：老键 `shuyonote:backupReminder` 可能还躺在别人的 localStorage 里 ⇒ 已经没人读了 ✓；
  //       `shuyonote:lastBackupAt` 仍由 `BackupButton` 写入 ⇒ 现在**只写不读** ✓。

  // A database page renders a table view instead of the block editor.
  if (current?.kind === "database") {
    return (
      <div className="main">
        <DatabaseView pageId={pageId} title={current.title} />
      </div>
    );
  }

  return (
    <div className="main">
      {/* 阶段 1 · 冲突提示条：同一块被两端改过时**看得见**（裁定 (iii) 的"不静默选边"） */}
      <ConflictBanner pageId={pageId} />
      {/* 冲刺 §13.3 第 2 条 · **页级**血统冲突提示条：两条独立编辑历史撞上时，给"另存为新页/保留本机" */}
      <LineageConflictBanner pageId={pageId} />
      <div className="editor-toolbar-bar">
        {breadcrumbs.length > 0 && (
          <div className="breadcrumbs">
            {breadcrumbs.map((b, i) => (
              <span key={b.id}>
                {i > 0 && <span className="crumb-sep">/</span>}
                <button
                  className="crumb"
                  onClick={() =>
                    b.kind === "folder"
                      ? (useFileManagerStore.getState().setFolderId(b.id),
                        useViewStore.getState().setView("files"))
                      : openPage(b.id)
                  }
                >
                  {b.title}
                </button>
              </span>
            ))}
          </div>
        )}
        <EditorToolbar pageId={pageId} />
      </div>
      <div className="note-scroll" ref={scrollRef}>
        {current?.cover ? (
          <div
            className="page-cover"
            style={{
              backgroundImage: current.cover,
              backgroundPosition: `center ${coverPos ?? current.cover_pos ?? 50}%`,
              height: coverH ?? current.cover_height ?? 300,
            }}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              if ((e.target as HTMLElement).closest(".page-cover-handle")) return;
              coverPosRef.current = coverPos ?? current?.cover_pos ?? 50;
              coverPosDrag.current = { sy: e.clientY, sp: coverPosRef.current, moved: false };
              (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
            }}
            onPointerMove={(e) => {
              if (coverPosDrag.current && current) {
                const dy = e.clientY - coverPosDrag.current.sy;
                if (!coverPosDrag.current.moved && Math.abs(dy) < 4) return;
                coverPosDrag.current.moved = true;
                const next = Math.max(0, Math.min(100, coverPosDrag.current.sp - (dy / (coverH ?? current.cover_height ?? 300)) * 100));
                coverPosRef.current = next;
                setCoverPos(next);
              }
            }}
            onPointerUp={async () => {
              if (coverPosDrag.current && current) {
                const moved = coverPosDrag.current.moved;
                coverPosDrag.current = null;
                if (moved) {
                  await api.setPageCoverPos(current.id, coverPosRef.current);
                  await useNotes.getState().openPage(current.id);
                  setCoverPos(null);
                }
              }
            }}
          >
            <span
              className="page-cover-handle"
              title="拖拽调整高度"
              onPointerDown={(e) => {
                const el = e.currentTarget as HTMLElement;
                coverHRef.current = coverH ?? current?.cover_height ?? 300;
                coverDrag.current = { sy: e.clientY, sh: coverHRef.current };
                el.setPointerCapture?.(e.pointerId);
              }}
              onPointerMove={(e) => {
                if (coverDrag.current && current) {
                  const next = Math.max(120, Math.min(720, coverDrag.current.sh + (e.clientY - coverDrag.current.sy)));
                  coverHRef.current = next;
                  setCoverH(next);
                }
              }}
              onPointerUp={async () => {
                if (coverDrag.current && current) {
                  coverDrag.current = null;
                  await api.setPageCoverHeight(current.id, coverHRef.current);
                  await useNotes.getState().openPage(current.id);
                  setCoverH(null);
                }
              }}
            />
          </div>
        ) : null}
        <div className="title-area">
          <div className="page-icon-row">
            {current?.icon ? (
              <button
                className="page-icon-btn"
                onClick={() =>
                  useIconPicker.getState().openIconPicker(async (icon) => {
                    if (current) {
                      await api.setPageIcon(current.id, icon);
                      await useNotes.getState().openPage(current.id);
                    }
                  })
                }
                title="更换图标"
              >
                {/^(data:image|https?:|\.svg)/i.test(current.icon) ? (
                  <img className="page-icon-img" src={current.icon} alt="" draggable={false} />
                ) : (
                  <span className="page-icon">{current.icon}</span>
                )}
              </button>
            ) : null}
          </div>
          <div className="page-actions">
            <button
              className="page-action-btn"
              onClick={() =>
                useIconPicker.getState().openIconPicker(async (icon) => {
                  if (current) {
                    await api.setPageIcon(current.id, icon);
                    await useNotes.getState().openPage(current.id);
                  }
                })
              }
            >
              <SmileIcon className="page-action-icon" /> {current?.icon ? "更换图标" : "添加图标"}
            </button>
            <button
              className="page-action-btn"
              onClick={() => setCoverOpen(true)}
            >
              <ImageIcon className="page-action-icon" /> {current?.cover ? "更换题头图" : "添加题头图"}
            </button>
          </div>
          <div className="editor-head">
            <div className="title-row">
              <textarea
                ref={titleRef}
                className="title-input"
                rows={1}
                value={title}
                placeholder="新页面"
                onChange={(e) => onTitleChange(e.target.value)}
                onKeyDown={onTitleKeyDown}
              />
              <span className={`save-indicator ${saved ? "saved" : ""}`}>
                {saved ? "已保存" : "保存中…"}
              </span>
              {error && <span className="error-badge">{error}</span>}
            </div>
          </div>
        </div>
        <InlineAiDraftBar />
        <PropertiesPanel pageId={pageId} />
        <div className="editor-stage">
          <ErrorBoundary>
            <Editor
              key={`${pageId}:${reloadTick}`}
              pageId={pageId}
              contentJson={current?.content_json ?? ""}
              onSave={onEditorSave}
              searchQuery={searchQuery}
            />
          </ErrorBoundary>
          {current && !hasBlockContent(current.content_json) && <NewPageGuide />}
        </div>
        <BacklinksPanel pageId={pageId} />
        <UnlinkedMentionsPanel />
        <AttachmentPanel pageId={pageId} />
      </div>
      {/* Tag picker modal, opened by the page-actions "添加标签" row. */}
      <TagAddButton pageId={pageId} />
      <TableOfContents />
      <EmojiPicker />
      {coverOpen && (
        <CoverPicker
          current={current?.cover}
          onClose={() => setCoverOpen(false)}
          onPick={async (css) => {
            if (current) {
              await api.setPageCover(current.id, css);
              await useNotes.getState().openPage(current.id);
            }
            setCoverOpen(false);
          }}
        />
      )}
    </div>
  );
}

// 口令锁的闸门与外壳**拆成两个组件**，不是为了好看，是为了不犯 hooks 的规矩。
//
// 原先闸门就是 App 里的一句早退，而它的位置在七八个 hooks **之前**：
//
//     const [enc, setEnc] = useState(...)   // 首帧 null → 不算锁定 → 这一帧跑了 N 个 hooks
//     ...若干 hooks...
//     if (locked) return <LockScreen/>      // 状态回来后的这一帧只跑 N-3 个 → React 直接抛错
//
// 于是「开着加密重启应用」这条最常见的路径上，第二帧就抛
// `Rendered fewer hooks than expected. This may be caused by an accidental early
// return statement.`，被根部 ErrorBoundary 接住——用户看到的是**崩溃屏**，
// 而 E1 那道锁定屏**根本没机会出现**（真机没验过重启这条路径，所以一直没暴露）。
//
// 现在：`App` 自己只有一个 hook，分支只决定渲染**哪个组件**，不再改变 hook 数量；
// 而读库的外壳（AppShell）在锁定态下**根本不挂载**，比"挂载起来再把界面挡住"更干净。
//
// ⭐ 2026-10-10（owner 亲口报的缺陷：「一个空间加密，其它空间怎么还需要密码？」）：
//   闸门判的是 ⭐ **当前活动空间**加不加密（`activeSpaceEncrypted` ✓）—— 这一点原先就是对的
//   （内核的 `enabled` 按活动空间算；启动时的 `LOCKED` 也只看活动空间的文件头 ✓）。
//   ✗ 真正出事的是**下一层**：`enabled && locked` 一旦为真，`AppShell` **整块不挂载**，
//     而**空间切换器在 AppShell 里** ⇒ 用户**出不去**，只能先输那个加密空间的口令 ——
//     于是"一个空间的口令"事实上变成了"整个应用的开关" ✗，这就是 owner 说的那件事 ✓。
//   ⇒ 修法不是把闸门放开（那会把加密空间也放进来 ✗），而是**在锁定屏上给一条出路**：
//     `LockScreen` 会列出本机**明文**的那些空间，点一下就换过去 ⇒ 换完 `activeSpaceEncrypted`
//     自己变 false ⇒ 闸门自然放开 ✓（见 `lib/vault.ts::switchToSpace` ✓）。
/**
 * ⭐ **移动端内容外壳**（纯重构那一刀 ✓，2026-10-19）：把移动端那几屏统一裹一层 `.m-tabshell` ✓，
 * 为后面的**底栏 ＋ 留白**留位置 ✓。
 *
 * ⚠️ ⭐ **刻意"同一函数在两处各包一次"，而不是"把两处内容提成一个变量"** ✗ ——
 *    这两处在渲染链里**顺序不同** ✓：`settings` 支排在 `aboutOpen`／`currentId` **之前** ✓，
 *    capture/search/home 排在**最后** ✓ ⇒ 提成变量挪到最后会**改变行为** ✗
 *    （例如开着一条笔记时进设置，会被阅读屏抢走 ✗）。⇒ 零行为变化 ✓、也⛔ 没有第二份外壳 ✓。
 *
 * ⭐ 2026-10-20：多一个**显式**选项 `showFab`（默认 true ✓，既有调用一个字不改 ✓）——
 *    留给需要整屏专注、不挂那颗浮「＋」的移动屏（⭐ 参数保留，本轮无调用方 ✓）。
 */
const wrapMobile = (body: React.ReactNode, opts?: { showFab?: boolean; showTabs?: boolean }) => (
  <div className={opts?.showTabs === false ? "m-tabshell m-tabshell--no-tabs" : "m-tabshell"}>
    {body}
    {/* ⭐ 第二刀：底栏三项（笔记/搜索/我的）＋ 右下浮「＋」。两者都 `position: fixed` ✓，
        所以放在 body 之后即可（不参与 `.m-tabshell` 的 column flex ✓）。
        ⭐ 2026-10-22（owner 手机实拍「编辑时底部标签不该显示」）：多一个显式选项 `showTabs`
        （默认 true ⇒ 既有调用一个字不改）—— 打字屏要整屏专注：底栏会把快捷工具栏顶到键盘上，
        而且那三个导航项在"正在写"的时候也用不上。⚠️ 于是那个屏**必须自己留一条回家的路**
        （`MobileCapture` 左上「‹ 返回」✓，`check-mobile-exit-routes` 也认它）。 */}
    {opts?.showTabs === false ? null : <MobileTabBar />}
    {opts?.showFab === false ? null : <MobileComposeFab />}
  </div>
);

function App() {
  const vault = useVault();
  // 状态未知的首帧什么都不渲染：锁定安装上若先挂外壳，外壳会立刻去读还没解锁的库。
  if (!vault.ready) return null;
  if (vault.activeSpaceEncrypted && vault.locked) return <LockScreen />;
  return <AppShell />;
}

function AppShell() {
  // 逐字段订阅（`loadPages` 是动作，引用恒定）。
  const pages = useNotes((s) => s.pages);
  const currentId = useNotes((s) => s.currentId);
  // 启动那次"打开哪一页"的决定是否已落定（见下面那个兜底 effect 与 `loadPages` 的注释）。
  const startupSettled = useNotes((s) => s.startupSettled);
  const error = useNotes((s) => s.error);
  const loadPages = useNotes((s) => s.loadPages);
  const view = useViewStore((s) => s.view);
  const setView = useViewStore((s) => s.setView);
  const templateOpen = useViewStore((s) => s.view === "templates");
  useSyncStream();
  // 中继租约的兜底续期：6 小时一次（面板不常开，光靠面板挂载不够）。
  useLeaseAutoRefresh();
  // ⭐ M2（施工单 Task W3/W4）：**外部 AI 的写请求**从这条事件进来 —— 默认弹确认、
  //    免确认开关开着时直接落库并留一句看得见的痕 ✓（判断逻辑在 `src/lib/externalDrafts.ts` ✓）。
  useExternalDrafts();
  // ⭐ B3（2026-10-29）：**Rust→前端桥**（导出 Markdown/.shuyodoc、覆盖率报告）——
  //    只在主窗口挂；前端用现有 TS 实现算，回执给 Rust（那边只做句柄登记/透传，⛔ 不重写一份）。
  useMcpFrontendTools();
  // P1：把 Rust 侧的附件同步进度接进 useSyncStatus（Web 引擎自己会上报，不需要这条）。
  useSyncProgress();
  // ★ 2026-09-29：**开机就把「局域网这一档开着吗」读一次**。
  //
  // ⚠️ 位置很要紧：它**必须在 `AppShell` 里**，不能放在 `NoteEditor` 里 ——
  //    第一次我插进了 `NoteEditor`（那个组件只有【打开某一页】才挂载），于是
  //    "改了没生效"、而且**它的表现与"没插"完全一样**（这一点值得记：
  //    组件摆错位置时，代码在、但你永远看不到它跑）。
  // 为什么必须有这一步（否则是鸡生蛋）：自动定时器的间隔由 `effectiveAutoSyncMs()` 定，
  // 而它要看"局域网档开着吗"；那个状态原本只由**同步面板**轮询时喂进来
  // ⇒ 用户上次开了网格、这次【没打开面板】⇒ 间隔停在 5 分钟，
  //    而要靠定时器把它读出来得先等 5 分钟 ⇒ **永远轮不到**。
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const wsId = await api.getActiveWorkspaceId();
        const st = await api.lanStatus(wsId ?? undefined);
        // 用 **Rust 判好的那个结论**（＝ `cfg.bind.is_some()`）去喂，
        // 不按地址形状自己再判一次档（判据 ⑭ 钉的是后者）。
        // ⚠️ 这一行**不许**再写出那个字段名（"网格" ＋ "开着吗"那个 Rust 字段的字面量）：
        //    `syncPanelMesh.wiring.test.ts` ①b 是**文本级**判据（不剥注释），它扫到就会红。
        //    2026-09-29 实测：HEAD 上这一行注释里正好写着它 ⇒ 那条判据是**既存红**；
        //    处置照 `check-doc-content-access` 文件头第 2 条 —— **改措辞**，用中文描述该字段。
        if (alive) setLanMeshActive(!!st?.mesh?.enabled);
      } catch (e) {
        // 读不到（命令没注册 / 老构建 / 还没绑空间）⇒ **维持默认（5 分钟）**。
        // ⚠️ 不装成"没开网格"，也不静默改成 5 秒 —— 读不到就是读不到。
        // ⚠️⚠️ 但要**留痕**：第一版这里是空 `catch {}`，于是"根本没调到 lanStatus"
        //     被静默吞掉，表现成"改了没生效"（正是本仓那条"不许静默"的又一次踩）。
        console.warn("[sync] 开机读 lan_status 失败 ⇒ 局域网档仍按 5 分钟兜底", e);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  const isMobile = useMobile();
  // ⭐ 2026-10-23（owner 报「系统标题栏好丑」）：macOS 走**原生透明标题栏**
  //   （`src-tauri/src/lib.rs` 的 `title_bar_style(Overlay) + hidden_title`）。
  //   `is-macos` 只在「桌面 macOS 且**没开**自绘栏」时挂上 —— 那套 CSS 把每列内容
  //   整体让出 28px（红绿灯占位），顶栏底色由各列自己的背景提供，不再有一条白条。
  //   ⛔ 自绘栏（`custom`）开着时不挂：那时窗口无边框、自绘栏自己占 32px（两套不能叠加）。
  const customTitleBar = useWindowChrome((s) => s.custom);
  const macNativeChrome = !isMobile && !customTitleBar && isMacDesktopPlatform();
  const appClass = macNativeChrome ? "app is-macos" : "app";
  // ⭐ 2026-10-10：手机档的**「关于」屏**（效果图 `10-about.svg`，规格 §4.10）——
  // **沿用既有的 `aboutOpen`** ✓（设置 → 关于与更新 ✓／命令面板 ✓），⛔ 不新造入口 ✗；
  // 手机档改渲染 `MobileAbout` ✓，桌面档仍是那个 `AboutDialog` ✓（一个字不动 ✓）。
  const aboutOpen = useEditorStore((s) => s.aboutOpen);
  // ⭐ 2026-10-10：移动端的**整屏**屏栈（首页／快速记录…）—— 只在 `isMobile` 那一支里用 ✓，
  // 桌面的 `view`（`useViewStore`）**一个字不动** ✓（两者不是一回事，见 `store/mobileNav.ts` ✓）。
  const mobileScreen = useMobileNav((s) => s.screen);
  // M24：PDF 阅读器在**桌面端是内容区的一种视图**（和 Markdown 阅读器一样，侧边栏与右栏都留着），
  // 窄屏才回到全屏浮层（那时侧边栏本来就是抽屉）。
  const pdfOpen = usePdfReader((s) => s.open);
  const pdfWhere = pdfPlacement(pdfOpen, isMobile);
  // ⚠️ **2026-10-04 加**（owner：「pdf 和文件预览面板可否跟页面一个级别」）：
  //   ⭐ 文件预览走**同一条放置规则** ✓ —— `pdfPlacement` 名字虽带 pdf，规则是通用的
  //   「⭐ 桌面 ⇒ 内容区里的一种视图（inline）／ ⭐ 窄屏 ⇒ 全屏浮层（overlay）／ ⭐ 关着 ⇒ none」✓。
  //   ⚠️ 刻意**不新写一个同义函数** ✗ —— 那正是本仓最忌讳的"两份真相源" ✓（一份规则一个出处 ✓）。
  //   优先级：⭐ PDF 在**它前面**判 ✓ ⇒ ⭐ 两个都开着时 PDF 占主区 ✓（与改动前一致 ✓）。
  const previewTarget = useFilePreview((s) => s.target);
  const previewWhere = pdfPlacement(!!previewTarget, isMobile);
  const sidebarOpen = useActivity((s) => s.sidebarOpen);
  const railOpen = useActivity((s) => s.railOpen);
  useUpdateChecker();
  useGlobalShortcuts(() =>
    setView(view === "notes" ? "board" : view === "board" ? "graph" : "notes"),
  );

  // Standalone window mode: ?page=<id> renders a single-page editor only.
  const standaloneId = new URLSearchParams(window.location.search).get("page");

  // 外壳只在**已解锁**时挂载（闸门在 App 里），所以这里直接加载即可：解锁后外壳是一次
  // 全新挂载，页面必然重新读一遍。
  useEffect(() => {
    loadPages();
  }, []);

  // Auto-open the first page/database (never a folder) when none is selected —
  // but only while sitting in the notes view, so navigating to a folder (files
  // view) or a board/graph doesn't yank the user back to a page.
  //
  // ⚠️ **2026-10-06（owner：「当前页面还是不能持久」）**：启动那一次必须**让位给
  //    `loadPages` 里的还原** —— 本 effect 会在 `set({pages})` 之后**先跑**，而"还原记住的那一页"
  //    还挂在 `await` 上 ⇒ 两个 `openPage` **赛跑**，且这里会把 `lastPageId` **改写成第一页** ✗
  //    ⇒ 记忆被自己抹掉、刷新永远回不到原页 ✓（真因就在这一行）。
  //    `startupSettled` 是 `loadPages` 落定后置的字段；它变 true 时本 effect 会重跑 ✓（在依赖里 ✓）。
  useEffect(() => {
    if (!startupSettled) return;
    // ⭐ 2026-10-10：手机档停在「首页」时**不许**把用户拽进页面 ✗ ——
    //   否则"存完回首页"与「‹ 首页」浮标都会被这一步**立刻抵消** ✗
    //   （队友实测：DB 里真写进去了 ✓、点击也到了应用 ✓，但界面就是不动 ✗；
    //    真因就是这个"没选中就打开第一页"的兜底 ✗）。
    // ⭐ 2026-10-20：手机上**任何一屏**都不许被这条兜底拽走 ✓（原来只排除 home ✗）——
    //   实测真事故 ✗：`createPage` 内部会 `loadPages()` ✓ ⇒ `pages` 一变本 effect 就跑，
    //   在手机上把 `currentId`（此刻还是 null）打开成**列表第一页（欢迎页）** ✗，
    //   而那次 `openPage` 比 `createPage` 末尾的 `set({ currentId: 新页 })` **更晚落定**
    //   ⇒ 刚生成的笔记被顶掉、用户看到旧页 ✗。
    //   启动时"打开记忆里那一页"由 `loadPages` 自己完成（`store/notes.ts` ✓）⇒
    //   手机上这条兜底本来就是多余的 ✓；桌面档一个字不动 ✓。
    if (isMobile) return;
    if (!currentId && pages.length > 0 && useViewStore.getState().view === "notes") {
      const first = pages.find((p) => p.kind === "page" || p.kind === "database");
      if (first) useNotes.getState().openPage(first.id);
    }
  }, [pages, currentId, startupSettled]);

  // ⛔ **2026-10-08（owner：「不要自动插入帮助文档了」✓）：这里原来是"首次进空间静默创建整套
  //    「使用指南」Wiki"** ✗ —— 已**停掉自动那条** ✓。⚠️ 刻意**不留开关**：半开的默认值最容易
  //    变成"看着关了其实还在建"✗。需要时为时**按需创建** ✓，入口都在：编辑器里打 `/帮助` ✓、
  //    命令面板里的「帮助 / 使用指南」✓（`openGuide` 本身**幂等**：已存在就不重复建 ✓）。
  //    ⚠️ 历史数据不受影响：**已经建过的空间里那些页面照旧在** ✓（要不要清掉是**数据**问题，另问 owner ✓）。

  if (standaloneId) {
    return (
      <div className={appClass}>
        {/* 独立页面窗口没有左竖条 ⇒ macOS 上由主区自己让位、拖拽带铺满顶边。 */}
        <TitleBar standalone />
        <UpdateBanner />
        <div className="app-body">
          <div className="main">
            <NoteEditor pageId={standaloneId} />
          </div>
        </div>
        <PanelBoundary name="命令面板">
          <CommandPalette />
        </PanelBoundary>
        <PanelBoundary name="插件视图">
          <PluginViewOverlay />
        </PanelBoundary>
        <PanelBoundary name="插件面板">
          <PluginViewPanel />
        </PanelBoundary>
        <PanelBoundary name="插件管理">
          <PluginManager />
        </PanelBoundary>
        {/* 其余根部浮层给一道兜底边界：它们与上面三个同理，不该因为一个渲染错误
            把整个界面带走（1.85.1 的白屏就是这么发生的）。 */}
        <PanelBoundary name="浮层">
          <ShortcutsPanel />
          {/* ⭐ 2026-10-10：手机档这一层由**主区**的 `MobileAbout` 承担 ✓（规格 §4.10）——
              ⛔ 桌面档一个字不动 ✓：`isMobile` 为假时照旧是那个 `AboutDialog` ✓。 */}
          {isMobile ? null : <AboutDialog />}
          <SettingsDialog />
          <SpaceTransferProgress />
          {/* ⚠️ **2026-10-04 改**：⭐ 顶层这份**只在浮层形态**渲染 ✗ —— 桌面端它在上面那条 `.main` 分支里 ✓
              （⭐ 与紧邻的 `{pdfWhere === "overlay" && <PdfReader />}` 同一写法 ✓）。 */}
          {previewWhere === "overlay" && <FilePreviewDialog />}
          <CommunitySaveDialog />
          <MarkdownExportDialog />
          <PdfReader />
          <FormulaEditorDialog />
          <Toaster />
          <ConfirmDialog />
          <InputDialog />
          <AiAssistantPanel />
        </PanelBoundary>
      </div>
    );
  }

  return (
    <div className={appClass}>
      <TitleBar />
      <UpdateBanner />
      {/* ⚠️ 2026-10-01（owner 界面方向之①）：入口搬到**顶端工具栏** ✓ —— 但 `TitleBar`
          **只在桌面平台渲染**（Web 里 return null ✗）⇒ Web 与手机必须**自己渲染一处** ✓，
          否则 Web 用户会丢掉全部四个入口 ✓（这是判据实测到的：桌面四颗＝0 颗 ✗）。 */}
      {(!isDesktopPlatform() || isMobile) && <TopTools className={isMobile ? "is-mobile" : "is-web"} />}
      {/* ⚠️ 2026-10-01（owner 界面方向之①）：**手机上标题栏不渲染**（`TitleBar` 非桌面 return null ✓），
          而 owner 要求两端都有这条顶端工具栏 ✓ ⇒ 这里给手机渲染一行，用的是**同一个组件** ✓。
          桌面那一份在 `TitleBar` 里 ✓（⛔ 两处各写一份 = 两份真相源 ✗）。 */}
      {isMobile && <TopTools className="is-mobile" />}
      {/* ⭐ 2026-10-10 → **2026-10-22 退役**：这里原先有一颗 position:fixed 的「‹ 首页」浮标
          （台账 R188 的 (b)），来由是一次真死路：快速记录存完落进编辑器，而那个屏按返回键
          **直接退出应用**、重启**仍回编辑器**、抽屉里也没有「首页」⇒ 除 pm clear 没有回家的路。
          ⭐ 现在两条真路都建好了 ⇒ 浮标**冗余**（它压在正文右下角，还让"回家"有两个入口）：
             · 阅读屏顶栏的「‹ 阅读」（MobileRead.tsx 的 goHome，动作与它逐字相同）；
             · 底栏三格（笔记 / 搜索 / 我的）。
          ⚠️ 所以删它时必须**同时有判据**：scripts/check-mobile-exit-routes.mjs
             要求"每个移动屏都有 ≥1 条回家的路" —— 否则删浮标只是把问题藏起来。 */}
      <div className="app-body">
        <ActivityBar />
        <PageTree view={view} onViewChange={setView} />
        {isMobile && sidebarOpen && (
          <div
            className="mobile-sidebar-backdrop"
            onClick={() => useActivity.getState().setSidebarOpen(false, { persist: false })}
            aria-hidden
          />
        )}
        {/* 窄屏：左侧竖条改成浮层，默认收起（48px 常驻会吃掉 390px 视口的 12%）。
            ⭐ 2026-10-19 第二刀：原来左下角的 ☰（`.mobile-rail-toggle`）**已删** ✓ ——
            手机上不再有"展开工具栏"的入口 ✓；设置 / 关于 / 设备配对改由底栏「我的」进 ✓
            （见 `MobileTabBar.tsx` ✓）。⇒ `railOpen` 不会再被 UI 置真 ✓；下面那支遮罩代码**保留**
            （无害 ✓，门禁里仍可经 store 直接打开它来量几何 ✓）。
            ⚠️ 同步入口也**不再挂在这里** ✓：它搬进了 `MobileSettings`（底栏「我的」✓）。 */}
        {isMobile && railOpen && (
          <div
            className="mobile-rail-backdrop"
            onClick={() => useActivity.getState().setRailOpen(false)}
            aria-hidden
          />
        )}
      {pdfWhere === "inline" ? (
        <div className="main pdf-main"><PdfReader inline /></div>
      ) : previewWhere === "inline" ? (
        /* ⚠️ **2026-10-04 加**：⭐ 文件预览在桌面端也进主区 ✓（与上面 PDF 那条**逐字同形** ✓）——
           ⭐ 它顶替的是"文件"视图（预览从文件列表里点开 ✓）⇒ ⭐ 关掉之后回到原来的视图 ✓
           （⭐ `view` 没有被改过 ✓，⭐ patch 只是临时占了主区 ✓）。 */
        <div className="main"><FilePreviewDialog inline /></div>
      ) : templateOpen ? (
        <div className="main"><Suspense fallback={<ViewLoader />}><TemplateCenterView /></Suspense></div>
      ) : view === "graph" ? (
        <div className="main"><Suspense fallback={<ViewLoader />}><GraphView /></Suspense></div>
      ) : view === "timeline" ? (
        <div className="main"><Suspense fallback={<ViewLoader />}><TimelineReview /></Suspense></div>
      ) : view === "map" ? (
        <div className="main"><Suspense fallback={<ViewLoader />}><KnowledgeMap /></Suspense></div>
      ) : view === "board" ? (
        <div className="main"><Suspense fallback={<ViewLoader />}><BoardView /></Suspense></div>
      ) : view === "files" ? (
        <div className="main"><Suspense fallback={<ViewLoader />}><FileManagerView /></Suspense></div>
      ) : view === "sync" ? (
        /* ⭐ **P-2a-1（2026-10-13）**：⭐ 同一份内容（`SyncPanel` 的内容体 ✓）也能进**内容区** ✓ ——
           ⚠️ 抽屉那支（触发器 ＋ 浮层）**逐字不变** ✓；这里只是把同一份 JSX 放进 `main` ✓。 */
        <div className="main"><SyncPanel contentOnly /></div>
      ) : isMobile && mobileScreen === "pair" ? (
        /* ⭐ 2026-10-10：手机档的**「设备配对 · 同步」屏**（规格 §4.8）——
           它排在 `currentId` **前面**：那颗「同步」胶囊是**常驻**的 ✓ ⇒ 不管底下开着什么，
           点了就该整屏看到它 ✓。⛔ 桌面档**一个字不动** ✗（Still 走 `SyncPanel` 那个浮层 ✓）。 */
        <MobilePair />
      ) : isMobile && mobileScreen === "paircode" ? (
        /* ⭐ d1（2026-10-17）：**「首次配对」屏骨架** ✓ —— 从「设备直连」那两颗入口进来 ✓。
           ⚠️ 本轮只是**骨架 ＋ 明标未接** ✗（20 格对码要等 d2 ✓）。 */
        <MobilePairCode />
      ) : isMobile && mobileScreen === "settings" ? (
        /* ⭐ 2026-10-14 阶段 2（R205）：手机档的**「设置」屏**（`MobileSettings` ✓）——
           它排在 `aboutOpen` **之前**（照 `pair` 的先例 ✓）：那颗 ⚙️ 是"去开一个面板"的**动作** ✓
           ⇒ 不管底下开着什么（含"关于"是否已打开 ✓），点了就该整屏看到移动设置 ✓。
           ⛔ 桌面档**一个字不动** ✗（桌面的 ⚙️ 仍开那个 `SettingsDialog` ✓，分岔在 `ActivityBar` 里 ✓）。 */
        wrapMobile(<MobileSettings />, { showFab: false })
      ) : isMobile && aboutOpen ? (
        /* ⭐ 2026-10-10：手机档的**「关于」屏**（效果图 `10-about.svg`，规格 §4.10）——
           它排在 `currentId` **前面**：从设置里点「关于与更新」时，不管底下有没有开着页，
           都该整屏看到「关于」✓。⛔ 桌面档的 `AboutDialog` 一个字不动 ✓
           （下面那两处根部浮层照旧渲染它 ✓）。 */
        <MobileAbout />
      ) : currentId ? (
        /* ⭐ 2026-10-10：手机档点开一条笔记 ⇒ 走**移动端阅读屏**（效果图 `04-read.svg`，规格 §4.4）✓，
           而不是桌面块编辑器（顶栏是桌面那套图标工具条、还能拖块 ✗ —— 与效果图差得最远 ✓）。
           ⛔ **桌面档一个字不动** ✓：同一个三元里，`isMobile` 为假时仍是下面那个 `NoteEditor` ✓。 */
        isMobile ? <MobileRead pageId={currentId} /> : <NoteEditor pageId={currentId} />
      ) : isMobile ? (
        /* ⭐ 2026-10-10：手机档的"什么都没打开"⇒ 走**移动端首页**（三个入口 ✓ 无侧边栏 ✓），
           而不是桌面空态（那句"或按 Ctrl+N"在手机上本来就是错的 ✗）。
           第二屏「快速记录」、第三屏「**03 搜索**」也在这支里（`mobileNav.screen` ✓）。
           ⛔ 桌面分支一个字没动 ✓（下一个 else 就是原来那套 ✓）。 */
        wrapMobile(
          mobileScreen === "capture" ? (
            <MobileCapture />
          ) : mobileScreen === "search" ? (
            <MobileSearch />
          ) : (
            <MobileHome />
          ),
          /* ⭐ 2026-10-20 重设计：浮「＋」只出现在**首页**（效果图 01 有；02/03/07 没有）
             ⇒ capture/search 隐藏，避免它压住快捷工具栏/搜索结果。
             ⭐ 2026-10-22（owner 手机实拍「编辑时底部标签不该显示」）：**打字屏连底栏也不挂**
             —— 效果图 02 本来就没有它；键盘弹起时它会把快捷工具栏顶上去。
             该屏的回家路由它自己的左上「‹ 返回」承担（`MobileCapture` 里那段注释）。 */
          { showFab: mobileScreen === "home", showTabs: mobileScreen !== "capture" },
        )
      ) : (
        <div className="main empty">
          <div className="empty-state">
            <div className="empty-icon">📝</div>
            <div className="empty-title">开始你的第一页</div>
            <div className="empty-desc">
              点击下方按钮新建页面，或按 <kbd>Ctrl</kbd> + <kbd>N</kbd>
            </div>
            <button className="empty-cta" onClick={() => useNotes.getState().createPage(null)}>
              ＋ 新建页面
            </button>
            {error && <div className="error-badge">{error}</div>}
          </div>
        </div>
      )}
      </div>
      <PanelBoundary name="命令面板">
        <CommandPalette />
      </PanelBoundary>
      <PanelBoundary name="插件视图">
        <PluginViewOverlay />
      </PanelBoundary>
      <PanelBoundary name="插件面板">
        <PluginViewPanel />
      </PanelBoundary>
      {/* 其余根部浮层给一道兜底边界：它们与上面三个同理，不该因为一个渲染错误
          把整个界面带走（1.85.1 的白屏就是这么发生的）。 */}
      <PanelBoundary name="浮层">
        <Toaster />
        <ConfirmDialog />
        <InputDialog />
        <MarkdownExportDialog />
        <AiAssistantPanel />
        {/* 阶段 1 · B1：正文索引补算（合并/裁决过的页面在后台补上；应用启动与每次同步结束后跑一趟） */}
        <TextRepairRunner />
        <ShortcutsPanel />
        {/* ⭐ 2026-10-10：手机档这一层由**主区**的 `MobileAbout` 承担 ✓（规格 §4.10）——
            ⛔ 桌面档一个字不动 ✓：`isMobile` 为假时照旧是那个 `AboutDialog` ✓。
            ⚠️ 这里与上面 `PanelBoundary` 那份是**两处**渲染点（上面那份在浮层边界里 ✓），
            两处都要挡 —— 我第一版只挡了一处，**实测截图里桌面对话框盖在我的屏上** ✗（已修 ✓）。 */}
        {isMobile ? null : <AboutDialog />}
        <SettingsDialog />
        <SpaceTransferProgress />
        {/* ⚠️ **2026-10-04 改**：⭐ 顶层这份**只在浮层形态**渲染 ✗ —— 桌面端它在上面那条 `.main` 分支里 ✓
            （⭐ 与紧邻的 `{pdfWhere === "overlay" && <PdfReader />}` 同一写法 ✓）。
            ⚠️ 这一处与上面那处（10 空格缩进）是**平行的两个外壳块** ⇒ ⭐ 两处都要改 ✗，漏一处就会
            ⭐ 桌面端渲染两次（一次内联 ＋ 一次全屏浮层）✓ —— 我第一遍就漏了它 ✓。 */}
        {previewWhere === "overlay" && <FilePreviewDialog />}
        <CommunitySaveDialog />
        {/* 窄屏才用全屏浮层；桌面端它在内容区里（见上面 pdfWhere 那条分支）。 */}
        {pdfWhere === "overlay" && <PdfReader />}
        <FormulaEditorDialog />
        {/* ⭐ task-14：Office 导入的**唯一入口**（右下角小按钮 ＋ `office-import://request` 监听）。
            ⚠️ 它**不是浮层**（容器类名不以 `-overlay`/`-popover` 结尾 ⇒ 无需登记返回栈 ✓）；
            放进 `PanelBoundary` 是为了它万一渲染出错也**带不走整个界面** ✓（与上面几条同理由 ✓）。 */}
        <OfficeImportPanel parentId={null} />
      </PanelBoundary>
      {/* 插件管理单独一层：它渲染的全是插件声明的数据（权限/设置/日志/校验报告），
          是根部浮层里最可能崩的一个，所以不与别的浮层共享边界。 */}
      <PanelBoundary name="插件管理">
        <PluginManager />
      </PanelBoundary>
    </div>
  );
}

export default App;
