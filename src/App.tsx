import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { PageTree } from "./components/PageTree";
import { BacklinksPanel } from "./components/BacklinksPanel";
import { UnlinkedMentionsPanel } from "./components/UnlinkedMentionsPanel";
import { AttachmentPanel } from "./components/AttachmentPanel";
import { PropertiesPanel } from "./components/PropertiesPanel";
import { DatabaseView } from "./components/DatabaseView";
import { TableOfContents } from "./components/TableOfContents";
import { NewPageGuide } from "./components/NewPageGuide";
import { CommandPalette } from "./components/CommandPalette";
import { ShortcutsPanel } from "./components/ShortcutsPanel";
import { AboutDialog } from "./components/AboutDialog";
import { UpdateBanner } from "./components/UpdateBanner";
import { FilePreviewDialog } from "./components/FilePreviewDialog";
import { PdfReader } from "./components/PdfReader";
import { FormulaEditorDialog } from "./components/FormulaEditorDialog";
import { CoverPicker } from "./components/CoverPicker";
import { Toaster } from "./components/Toaster";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { InputDialog } from "./components/InputDialog";
import { PluginManager } from "./components/PluginManager";
import { EditorToolbar } from "./components/EditorToolbar";
import { AiAssistantPanel } from "./components/AiAssistantPanel";
import { RightRail } from "./components/RightRail";
import { InlineAiDraftBar } from "./components/InlineAiDraftBar";
import { SmileIcon, ImageIcon, PropertyIcon, TagIcon } from "./components/icons";
import { TagAddButton } from "./components/TagBar";
import { LockScreen } from "./components/LockScreen";
import { useTemplateCenterStore } from "./store/templateCenter";
import { inputDialog } from "./store/input";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Editor } from "./editor/Editor";
import { useAutoSync } from "./hooks/useAutoSync";
import { useGlobalShortcuts } from "./hooks/useGlobalShortcuts";
import { useUpdateChecker } from "./lib/useUpdateChecker";
import { api } from "./lib/api";
import { openGuide, GUIDE_TITLE } from "./lib/guide";
import { useNotes } from "./store/notes";
import { useSpaceStore } from "./store/space";
import { useBlockCache } from "./store/blockCache";
import { useViewStore } from "./store/view";
import { useFileManagerStore } from "./store/fileManager";
import { usePropertyUiStore } from "./store/propertyUi";
import { toast } from "./store/toast";
import { platform } from "./lib/platform";
import { useAuth } from "./store/auth";
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
  const debounceRef = useRef<number | null>(null);

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
        loadPages();
        // Invalidate block-reference/embed caches so mirrors refresh.
        useBlockCache.getState().bump();
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
            style={{ backgroundImage: current.cover, height: coverH ?? current.cover_height ?? 300 }}
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
          <div className="page-actions">
            <button
              className="page-action-btn"
              onClick={() =>
                inputDialog({
                  title: "页面图标",
                  placeholder: "输入一个 emoji，如 📖 🧭 💡 🚀；留空清除",
                  okLabel: "设置",
                  onSubmit: async (v) => {
                    const icon = (v ?? "").trim();
                    if (current) {
                      await api.setPageIcon(current.id, icon);
                      await useNotes.getState().openPage(current.id);
                    }
                  },
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
            {current?.icon ? (
              /^(data:image|https?:|\.svg)/i.test(current.icon) ? (
                <img className="page-icon-img" src={current.icon} alt="" draggable={false} />
              ) : (
                <span className="page-icon">{current.icon}</span>
              )
            ) : null}
            <input
              className="title-input"
              value={title}
              placeholder="新页面"
              onChange={(e) => onTitleChange(e.target.value)}
            />
            <span className={`save-indicator ${saved ? "saved" : ""}`}>
              {saved ? "已保存" : "保存中…"}
            </span>
            {error && <span className="error-badge">{error}</span>}
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

function App() {
  const { pages, currentId, loadPages, error } = useNotes();
  const view = useViewStore((s) => s.view);
  const setView = useViewStore((s) => s.setView);
  const templateOpen = useTemplateCenterStore((s) => s.open);
  // E1: encryption gate — while enabled+locked the space DBs aren't readable, so we
  // hold off loading and show a lock screen until the user enters the passphrase.
  const [enc, setEnc] = useState<{ enabled: boolean; locked: boolean } | null>(null);
  useAutoSync();
  useUpdateChecker();
  useGlobalShortcuts(() =>
    setView(view === "notes" ? "board" : view === "board" ? "graph" : "notes"),
  );

  useEffect(() => {
    api
      .encryptionStatus()
      .then(setEnc)
      .catch(() => setEnc({ enabled: false, locked: false }));
  }, []);

  // Standalone window mode: ?page=<id> renders a single-page editor only.
  const standaloneId = new URLSearchParams(window.location.search).get("page");

  // E1: while locked the space DBs aren't readable, so show a lock screen instead of
  // loading any content. Unlock re-keys the DBs and the effect below reloads pages.
  const locked = enc ? enc.enabled && enc.locked : false;
  if (locked) {
    return <LockScreen onUnlocked={() => setEnc({ enabled: true, locked: false })} />;
  }

  useEffect(() => {
    if (!enc) return;
    if (enc.enabled && enc.locked) return; // wait for unlock
    loadPages();
  }, [enc]);

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
        <UpdateBanner />
        <div className="app-body">
          <div className="main">
            <NoteEditor pageId={standaloneId} />
          </div>
        </div>
        <CommandPalette />
        <ShortcutsPanel />
        <AboutDialog />
        <FilePreviewDialog />
        <PdfReader />
        <FormulaEditorDialog />
        <Toaster />
        <ConfirmDialog />
        <InputDialog />
        <AiAssistantPanel />
        <RightRail />
      </div>
    );
  }

  return (
    <div className="app">
      <UpdateBanner />
      <div className="app-body">
        <PageTree view={view} onViewChange={setView} />
      {templateOpen ? (
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
      <CommandPalette />
      <Toaster />
      <ConfirmDialog />
      <InputDialog />
      <PluginManager />
      <AiAssistantPanel />
      <RightRail />
      <ShortcutsPanel />
      <AboutDialog />
      <FilePreviewDialog />
      <PdfReader />
      <FormulaEditorDialog />
    </div>
  );
}

export default App;
