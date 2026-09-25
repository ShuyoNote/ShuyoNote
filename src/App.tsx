import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { PageTree } from "./components/PageTree";
import { SyncPanel } from "./components/SyncPanel";
import { ActivityBar } from "./components/ActivityBar";
import { TitleBar } from "./components/TitleBar";
import { useWindowChrome, applyDecorations } from "./store/windowChrome";
import { BacklinksPanel } from "./components/BacklinksPanel";
import { UnlinkedMentionsPanel } from "./components/UnlinkedMentionsPanel";
import { AttachmentPanel } from "./components/AttachmentPanel";
import { PropertiesPanel } from "./components/PropertiesPanel";
import { DatabaseView } from "./components/DatabaseView";
import { TableOfContents } from "./components/TableOfContents";
import { NewPageGuide } from "./components/NewPageGuide";
import { CommandPalette } from "./components/CommandPalette";
import { PluginViewOverlay } from "./components/PluginViewOverlay";
import { PluginViewPanel } from "./components/PluginViewPanel";
import { ShortcutsPanel } from "./components/ShortcutsPanel";
import { AboutDialog } from "./components/AboutDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { SpaceTransferProgress } from "./components/SpaceTransferProgress";
import { UpdateBanner } from "./components/UpdateBanner";
import { FilePreviewDialog } from "./components/FilePreviewDialog";
import { CommunitySaveDialog } from "./components/CommunitySaveDialog";
import { PdfReader } from "./components/PdfReader";
import { FormulaEditorDialog } from "./components/FormulaEditorDialog";
import { CoverPicker } from "./components/CoverPicker";
import { Toaster } from "./components/Toaster";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { InputDialog } from "./components/InputDialog";
import { PluginManager } from "./components/PluginManager";
import { EditorToolbar } from "./components/EditorToolbar";
import { ConflictBanner } from "./components/ConflictBanner";
import { TextRepairRunner } from "./components/TextRepairRunner";
import { AiAssistantPanel } from "./components/AiAssistantPanel";
import { CommentsDrawer } from "./components/CommentsDrawer";
import { RightRail } from "./components/RightRail";
import { InlineAiDraftBar } from "./components/InlineAiDraftBar";
import { SmileIcon, ImageIcon, PropertyIcon, TagIcon, MenuIcon } from "./components/icons";
import { TagAddButton } from "./components/TagBar";
import { LockScreen } from "./components/LockScreen";
import { useVault } from "./hooks/useVault";
import { useTemplateCenterStore } from "./store/templateCenter";
import { EmojiPicker } from "./components/EmojiPicker";
import { useIconPicker } from "./store/iconPicker";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { PanelBoundary } from "./components/PanelBoundary";
import { Editor } from "./editor/Editor";
import { useAutoSync } from "./hooks/useAutoSync";
import { usePresence } from "./hooks/usePresence";
import { useSyncStream } from "./hooks/useSyncStream";
import { useSyncProgress } from "./hooks/useSyncProgress";
import { shouldAutoSyncNow } from "./lib/syncGate";
import { useMobile } from "./hooks/useMobile";
import { useGlobalShortcuts } from "./hooks/useGlobalShortcuts";
import { useUpdateChecker } from "./lib/useUpdateChecker";
import { api } from "./lib/api";
import { openGuide, GUIDE_TITLE } from "./lib/guide";
import { createDeepLinkHandler } from "./lib/deepLinkDispatch";
import { useNotes } from "./store/notes";
import { usePlugins } from "./store/plugins";
import { emitHostEvent } from "./lib/pluginEvents";
import { applyThemeTokens, resolveTheme } from "./lib/pluginTheme";
import { useActivity } from "./store/activity";
import { useSpaceStore } from "./store/space";
import { useCommunitySave } from "./store/communitySave";
import { mountDeepLinks } from "./lib/deepLinkBridge";
import { useEditorStore } from "./store/editor";
import { $createParagraphNode, $getRoot } from "lexical";
import { useBlockCache } from "./store/blockCache";
import { useViewStore } from "./store/view";
import { usePdfReader } from "./store/pdfReader";
import { pdfPlacement } from "./lib/pdfPlacement";
import { useFileManagerStore } from "./store/fileManager";
import { usePropertyUiStore } from "./store/propertyUi";
import { toast } from "./store/toast";
import { platform } from "./lib/platform";
import { useAuth } from "./store/auth";
import { withSyncStatus } from "./store/syncStatus";
import "./App.css";

// Secondary views are code-split so the initial bundle stays lean; they load only
// when the user switches to graph / board / files / template-center (the default
// editor page stays synchronous). Heavy libs (cytoscape, mermaid…) are also lazy.
const GraphView = lazy(() => import("./components/GraphView").then((m) => ({ default: m.GraphView })));
const BoardView = lazy(() => import("./components/BoardView").then((m) => ({ default: m.BoardView })));
const FileManagerView = lazy(() => import("./components/FileManagerView").then((m) => ({ default: m.FileManagerView })));
const TemplateCenterView = lazy(() => import("./components/TemplateCenterView").then((m) => ({ default: m.TemplateCenterView })));

function ViewLoader() {
  return <div className="view-loading" role="status">加载中…</div>;
}

// A page "has content" if its serialized root has at least one top-level block.
// Used to show the new-page guide only for genuinely empty pages (a page with
// only an image/embed/table has empty `content_text` but does contain content).
function hasBlockContent(contentJson: string): boolean {
  if (!contentJson) return false;
  try {
    const parsed = JSON.parse(contentJson);
    const children = parsed?.root?.children;
    return Array.isArray(children) && children.length > 0;
  } catch {
    return contentJson.length > 0;
  }
}

function NoteEditor({ pageId }: { pageId: string }) {
  const { current, updateCurrent, loadPages, error, searchQuery, pages, reloadTick } = useNotes();
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

  // Restore the team-edition login state on startup (from meta.db session).
  useEffect(() => {
    void useAuth.getState().init();
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

  const persist = (patch: {
    title?: string;
    content_json?: string;
    content_text?: string;
  }) => {
    setSaved(false);
    pendingSaveRef.current = { pageId, patch };
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(async () => {
      const p = pendingSaveRef.current;
      pendingSaveRef.current = null;
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
      const p = pendingSaveRef.current;
      pendingSaveRef.current = null;
      if (p) {
        api.savePage({ id: p.pageId, ...p.patch }).catch((e) => {
          console.error("flush save failed", e);
          toast(`保存失败：${e}`, "error");
        });
      }
    };
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

  // 自动同步：按 SyncPanel 里设置的间隔（localStorage "shuyonote:autoSync"），
  // 对每个已绑定服务器的空间定时 push+pull（面板关闭也生效）。
  // 防重入：上一次自动同步尚未结束就跳过本次 tick，避免多次同步叠加/互相打断。
  const autoSyncMs = Number(localStorage.getItem("shuyonote:autoSync")) || 0;
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    let busy = false;
    const tick = () => {
      if (busy) return;
      busy = true;
      (async () => {
        try {
          // C2 网络闸门：**这条路也必须过闸**（真机验收发现它原先绕过了
          // `useAutoSync` 里那道检查——把面板间隔设成"每 10 秒"就会在蜂窝上照拉）。
          // 判据只有一处实现，见 `lib/syncGate.ts`。
          if (!(await shouldAutoSyncNow())) return;
          const profiles = await api.listSyncProfiles();
          const bound = (profiles || []).filter((p: any) => p.server_url && p.space_id);
          if (bound.length) {
            // P1：与 `useAutoSync` 同理——**自动同步必须配对 begin/end**
            // （`withSyncStatus` 保证），否则 Rust 侧的附件进度事件会把 store 置成
            // "正在同步"且没人收尾，面板就永远停在"正在同步…"（真机实测过）。
            await withSyncStatus("正在自动同步…", () =>
              Promise.all(
                bound.map((p: any) =>
                  api.syncWorkspace(p.ws_id).catch(() => null),
                ),
              ),
            );
            await loadPages();
          }
        } catch {
          /* 自动同步失败静默，下次再试 */
        } finally {
          busy = false;
        }
      })();
    };
    const ms = autoSyncMs;
    if (ms > 0) {
      timer = setInterval(tick, ms);
    }
    return () => { if (timer) clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, loadPages, autoSyncMs]);

  // 自动备份提醒（设置 → 数据 可配）：距上次成功备份超过设定天数，启动时提醒一次。
  useEffect(() => {
    try {
      const raw = localStorage.getItem("shuyonote:backupReminder");
      if (!raw) return;
      const cfg = JSON.parse(raw) as { enabled?: boolean; days?: number };
      if (!cfg.enabled) return;
      const days = Math.max(1, Number(cfg.days) || 30);
      const last = Number(localStorage.getItem("shuyonote:lastBackupAt")) || 0;
      if (last <= 0) return;
      const daysPast = (Date.now() - last) / 86400000;
      if (daysPast >= days) {
        toast(`距离上次备份已 ${Math.floor(daysPast)} 天。建议到「设置 → 数据 → 备份 / 恢复」做一次整库备份。`, "info");
      }
    } catch { /* ignore */ }
  }, []);

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
      <div className="note-scroll">
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
            <button
              className="page-action-btn"
              onClick={() => usePropertyUiStore.getState().requestAddProp()}
            >
              <PropertyIcon className="page-action-icon" /> 添加属性
            </button>
            <button
              className="page-action-btn"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                usePropertyUiStore.getState().setTagAnchor({ top: r.bottom, left: r.left, width: r.width });
                usePropertyUiStore.getState().requestAddTag();
              }}
            >
              <TagIcon className="page-action-icon" /> 添加标签
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
function App() {
  const vault = useVault();
  // 状态未知的首帧什么都不渲染：锁定安装上若先挂外壳，外壳会立刻去读还没解锁的库。
  if (!vault.ready) return null;
  if (vault.enabled && vault.locked) return <LockScreen />;
  return <AppShell />;
}

function AppShell() {
  const { pages, currentId, loadPages, error } = useNotes();
  const view = useViewStore((s) => s.view);
  const setView = useViewStore((s) => s.setView);
  const templateOpen = useTemplateCenterStore((s) => s.open);
  useAutoSync();
  usePresence();
  useSyncStream();
  // P1：把 Rust 侧的附件同步进度接进 useSyncStatus（Web 引擎自己会上报，不需要这条）。
  useSyncProgress();
  const isMobile = useMobile();
  // M24：PDF 阅读器在**桌面端是内容区的一种视图**（和 Markdown 阅读器一样，侧边栏与右栏都留着），
  // 窄屏才回到全屏浮层（那时侧边栏本来就是抽屉）。
  const pdfOpen = usePdfReader((s) => s.open);
  const pdfWhere = pdfPlacement(pdfOpen, isMobile);
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
  useEffect(() => {
    if (!currentId && pages.length > 0 && useViewStore.getState().view === "notes") {
      const first = pages.find((p) => p.kind === "page" || p.kind === "database");
      if (first) useNotes.getState().openPage(first.id);
    }
  }, [pages, currentId]);

  // 默认工作空间预置「使用指南」：首次进入时静默创建整套 Wiki（不自动打开），
  // 侧边栏即可见。用 localStorage 标记每个空间只预置一次；已存在则不重复（幂等）。
  useEffect(() => {
    if (!pages.length) return;
    const spaceId = useSpaceStore.getState().activeId;
    if (!spaceId) return;
    const key = "shuyo:guideSeeded:" + spaceId;
    try { if (localStorage.getItem(key) === "1") return; } catch { /* ignore */ }
    if (pages.some((p) => p.title === GUIDE_TITLE)) {
      try { localStorage.setItem(key, "1"); } catch {}
      return;
    }
    // 乐观标记，避免 pages 更新后重复触发；openGuide 幂等。
    try { localStorage.setItem(key, "1"); } catch {}
    openGuide({ open: false }).catch(() => {});
  }, [pages]);

  if (standaloneId) {
    return (
      <div className="app">
        <TitleBar />
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
          <AboutDialog />
          <SettingsDialog />
          <SpaceTransferProgress />
          <FilePreviewDialog />
          <CommunitySaveDialog />
          <PdfReader />
          <FormulaEditorDialog />
          <Toaster />
          <ConfirmDialog />
          <InputDialog />
          <AiAssistantPanel />
          <CommentsDrawer />
          <RightRail />
        </PanelBoundary>
      </div>
    );
  }

  return (
    <div className="app">
      <TitleBar />
      <UpdateBanner />
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
            左下角一个小圆钮唤出，点遮罩或选完活动自动收回。 */}
        {isMobile && railOpen && (
          <div
            className="mobile-rail-backdrop"
            onClick={() => useActivity.getState().setRailOpen(false)}
            aria-hidden
          />
        )}
        {isMobile && !railOpen && (
          <button
            className="mobile-rail-toggle"
            title="展开工具栏"
            aria-label="展开工具栏"
            onClick={() => useActivity.getState().setRailOpen(true)}
          >
            <MenuIcon width={18} height={18} />
          </button>
        )}
        {/* 手机上**整个顶栏不渲染**（`TitleBar` 在 `!desktop` 时 return null），于是桌面那个
            `.titlebar-sync` 根本不存在，同步入口只剩"侧栏抽屉 → 同步"这一条（要开抽屉才看得见）。
            这里在主界面上再放一个：与「展开工具栏」并排、1 次点击可达；窄屏下面板自己会变成
            底部弹层（`usePopover` 的 `is-sheet`）。侧栏抽屉里那个仍然保留（两处入口互不影响）。 */}
        {isMobile && !railOpen && (
          <div className="mobile-sync-slot">
            <SyncPanel />
          </div>
        )}
      {pdfWhere === "inline" ? (
        <div className="main pdf-main"><PdfReader inline /></div>
      ) : templateOpen ? (
        <div className="main"><Suspense fallback={<ViewLoader />}><TemplateCenterView /></Suspense></div>
      ) : view === "graph" ? (
        <div className="main"><Suspense fallback={<ViewLoader />}><GraphView /></Suspense></div>
      ) : view === "board" ? (
        <div className="main"><Suspense fallback={<ViewLoader />}><BoardView /></Suspense></div>
      ) : view === "files" ? (
        <div className="main"><Suspense fallback={<ViewLoader />}><FileManagerView /></Suspense></div>
      ) : currentId ? (
        <NoteEditor pageId={currentId} />
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
        <AiAssistantPanel />
        <CommentsDrawer />
        {/* 阶段 1 · B1：正文索引补算（合并/裁决过的页面在后台补上；应用启动与每次同步结束后跑一趟） */}
        <TextRepairRunner />
        <RightRail />
        <ShortcutsPanel />
        <AboutDialog />
        <SettingsDialog />
        <SpaceTransferProgress />
        <FilePreviewDialog />
        <CommunitySaveDialog />
        {/* 窄屏才用全屏浮层；桌面端它在内容区里（见上面 pdfWhere 那条分支）。 */}
        {pdfWhere === "overlay" && <PdfReader />}
        <FormulaEditorDialog />
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
