import { useEffect, useMemo, useRef, useState } from "react";
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
import { Toaster } from "./components/Toaster";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { InputDialog } from "./components/InputDialog";
import { PluginManager } from "./components/PluginManager";
import { BoardView } from "./components/BoardView";
import { GraphView } from "./components/GraphView";
import { FileManagerView } from "./components/FileManagerView";
import { EditorToolbar } from "./components/EditorToolbar";
import { AiAssistantPanel } from "./components/AiAssistantPanel";
import { RightRail } from "./components/RightRail";
import { InlineAiDraftBar } from "./components/InlineAiDraftBar";
import { SmileIcon, ImageIcon, PropertyIcon, TagIcon } from "./components/icons";
import { TagAddButton } from "./components/TagBar";
import { TemplateCenterView } from "./components/TemplateCenterView";
import { useTemplateCenterStore } from "./store/templateCenter";
import { inputDialog } from "./store/input";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Editor } from "./editor/Editor";
import { useAutoSync } from "./hooks/useAutoSync";
import { useGlobalShortcuts } from "./hooks/useGlobalShortcuts";
import { api } from "./lib/api";
import { useNotes } from "./store/notes";
import { useBlockCache } from "./store/blockCache";
import { useViewStore } from "./store/view";
import { useFileManagerStore } from "./store/fileManager";
import { usePropertyUiStore } from "./store/propertyUi";
import { toast } from "./store/toast";
import "./App.css";

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
        <div className="title-area">
          {current?.cover ? <div className="page-cover" style={{ background: current.cover }} /> : null}
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
              onClick={() =>
                inputDialog({
                  title: "题头图",
                  placeholder: "CSS 渐变，如 linear-gradient(135deg, #667eea, #764ba2)；留空清除",
                  okLabel: "设置",
                  onSubmit: async (v) => {
                    const cover = (v ?? "").trim();
                    if (current) {
                      await api.setPageCover(current.id, cover);
                      await useNotes.getState().openPage(current.id);
                    }
                  },
                })
              }
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
            {current?.icon ? <span className="page-icon">{current.icon}</span> : null}
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
    </div>
  );
}

function App() {
  const { pages, currentId, loadPages, error } = useNotes();
  const view = useViewStore((s) => s.view);
  const setView = useViewStore((s) => s.setView);
  const templateOpen = useTemplateCenterStore((s) => s.open);
  useAutoSync();
  useGlobalShortcuts(() =>
    setView(view === "notes" ? "board" : view === "board" ? "graph" : "notes"),
  );

  // Standalone window mode: ?page=<id> renders a single-page editor only.
  const standaloneId = new URLSearchParams(window.location.search).get("page");

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

  if (standaloneId) {
    return (
      <div className="app">
        <div className="main">
          <NoteEditor pageId={standaloneId} />
        </div>
        <CommandPalette />
        <ShortcutsPanel />
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
      <PageTree view={view} onViewChange={setView} />
      {templateOpen ? (
        <div className="main">
          <TemplateCenterView />
        </div>
      ) : view === "graph" ? (
        <div className="main">
          <GraphView />
        </div>
      ) : view === "board" ? (
        <div className="main">
          <BoardView />
        </div>
      ) : view === "files" ? (
        <div className="main">
          <FileManagerView />
        </div>
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
      <CommandPalette />
      <Toaster />
      <ConfirmDialog />
      <InputDialog />
      <PluginManager />
      <AiAssistantPanel />
      <RightRail />
    </div>
  );
}

export default App;
