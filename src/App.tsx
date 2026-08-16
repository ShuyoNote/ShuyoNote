import { useEffect, useRef, useState } from "react";
import { PageTree } from "./components/PageTree";
import { BacklinksPanel } from "./components/BacklinksPanel";
import { TagBar } from "./components/TagBar";
import { CommandPalette } from "./components/CommandPalette";
import { Editor } from "./editor/Editor";
import { useAutoSync } from "./hooks/useAutoSync";
import { api } from "./lib/api";
import { useNotes } from "./store/notes";
import "./App.css";

function NoteEditor({ pageId }: { pageId: string }) {
  const { current, updateCurrent, loadPages, error } = useNotes();
  const [title, setTitle] = useState(current?.title ?? "");
  const [contentJson, setContentJson] = useState(current?.content_json ?? "");
  const [saved, setSaved] = useState(true);
  const debounceRef = useRef<number | null>(null);

  // Sync local state when switching pages.
  useEffect(() => {
    setTitle(current?.title ?? "");
    setContentJson(current?.content_json ?? "");
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
    setContentJson(json);
    persist({ content_json: json, content_text: text });
  };

  // Flush pending save on unmount / page switch.
  useEffect(() => {
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, []);

  return (
    <div className="main">
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
      <Editor
        key={pageId}
        pageId={pageId}
        contentJson={contentJson}
        onSave={onEditorSave}
        onExport={async (markdown) => {
          try {
            await navigator.clipboard.writeText(markdown);
          } catch (e) {
            console.error("clipboard write failed", e);
          }
        }}
      />
      <BacklinksPanel pageId={pageId} />
      <TagBar pageId={pageId} />
    </div>
  );
}

function App() {
  const { pages, currentId, loadPages, error } = useNotes();
  useAutoSync();

  useEffect(() => {
    loadPages();
  }, []);

  // Auto-open first page if none selected.
  useEffect(() => {
    if (!currentId && pages.length > 0) {
      useNotes.getState().openPage(pages[0].id);
    }
  }, [pages, currentId]);

  return (
    <div className="app">
      <PageTree />
      {currentId ? (
        <NoteEditor pageId={currentId} />
      ) : (
        <div className="main empty">
          <div className="empty-hint">选择或新建一个页面开始记录</div>
          {error && <div className="error-badge">{error}</div>}
        </div>
      )}
      <CommandPalette />
    </div>
  );
}

export default App;
