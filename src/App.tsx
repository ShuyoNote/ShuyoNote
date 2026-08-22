import { useEffect, useMemo, useRef, useState } from "react";
import { PageTree } from "./components/PageTree";
import { BacklinksPanel } from "./components/BacklinksPanel";
import { TagBar } from "./components/TagBar";
import { AttachmentPanel } from "./components/AttachmentPanel";
import { PropertiesPanel } from "./components/PropertiesPanel";
import { DatabaseView } from "./components/DatabaseView";
import { NewPageGuide } from "./components/NewPageGuide";
import { CommandPalette } from "./components/CommandPalette";
import { Toaster } from "./components/Toaster";
import { BoardView } from "./components/BoardView";
import { GraphView } from "./components/GraphView";
import { FileManagerView } from "./components/FileManagerView";
import { EditorToolbar } from "./components/EditorToolbar";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Editor } from "./editor/Editor";
import { useAutoSync } from "./hooks/useAutoSync";
import { useGlobalShortcuts } from "./hooks/useGlobalShortcuts";
import { api } from "./lib/api";
import { useNotes } from "./store/notes";
import { useBlockCache } from "./store/blockCache";
import { useViewStore } from "./store/view";
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
  const { current, updateCurrent, loadPages, error, searchQuery, pages } = useNotes();
  const [title, setTitle] = useState(current?.title ?? "");
  const [saved, setSaved] = useState(true);
  const debounceRef = useRef<number | null>(null);

  // Build breadcrumb trail from the page tree.
  const breadcrumbs = useMemo(() => {
    const chain: { id: string; title: string }[] = [];
    const map = new Map(pages.map((p) => [p.id, p]));
    let cur = map.get(pageId);
    const visited = new Set<string>();
    while (cur && cur.parent_id && !visited.has(cur.id)) {
      visited.add(cur.id);
      const parent = map.get(cur.parent_id);
      if (parent) {
        chain.unshift({ id: parent.id, title: parent.title || "未命名" });
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

  const persist = (patch: {
    title?: string;
    content_json?: string;
    content_text?: string;
  }) => {
    setSaved(false);
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(async () => {
      try {
        const updated = await api.savePage({ id: pageId, ...patch });
        updateCurrent(updated);
        setSaved(true);
        loadPages();
        // Invalidate block-reference/embed caches so mirrors refresh.
        useBlockCache.getState().bump();
      } catch (e) {
        console.error("save failed", e);
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

  // Flush pending save on unmount / page switch.
  useEffect(() => {
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
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
                <button className="crumb" onClick={() => openPage(b.id)}>
                  {b.title}
                </button>
              </span>
            ))}
          </div>
        )}
        <EditorToolbar pageId={pageId} />
      </div>
      <div className="editor-head">
        <input
          className="title-input"
          value={title}
          placeholder="无标题"
          onChange={(e) => onTitleChange(e.target.value)}
        />
        <span className={`save-indicator ${saved ? "saved" : ""}`}>
          {saved ? "已保存" : "保存中…"}
        </span>
        {error && <span className="error-badge">{error}</span>}
      </div>
      <PropertiesPanel pageId={pageId} />
      <div className="editor-stage">
        <ErrorBoundary>
          <Editor
            key={pageId}
            pageId={pageId}
            contentJson={current?.content_json ?? ""}
            onSave={onEditorSave}
            searchQuery={searchQuery}
          />
        </ErrorBoundary>
        {current && !hasBlockContent(current.content_json) && <NewPageGuide />}
      </div>
      <BacklinksPanel pageId={pageId} />
      <TagBar pageId={pageId} />
      <AttachmentPanel pageId={pageId} />
    </div>
  );
}

function App() {
  const { pages, currentId, loadPages, error } = useNotes();
  const view = useViewStore((s) => s.view);
  const setView = useViewStore((s) => s.setView);
  useAutoSync();
  useGlobalShortcuts(() =>
    setView(
      view === "notes"
        ? "board"
        : view === "board"
          ? "graph"
          : view === "graph"
            ? "files"
            : "notes",
    ),
  );

  // Standalone window mode: ?page=<id> renders a single-page editor only.
  const standaloneId = new URLSearchParams(window.location.search).get("page");

  useEffect(() => {
    loadPages();
  }, []);

  // Auto-open first page if none selected.
  useEffect(() => {
    if (!currentId && pages.length > 0) {
      useNotes.getState().openPage(pages[0].id);
    }
  }, [pages, currentId]);

  if (standaloneId) {
    return (
      <div className="app">
        <div className="main">
          <NoteEditor pageId={standaloneId} />
        </div>
        <CommandPalette />
        <Toaster />
      </div>
    );
  }

  return (
    <div className="app">
      <PageTree view={view} onViewChange={setView} />
      {view === "graph" ? (
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
    </div>
  );
}

export default App;
