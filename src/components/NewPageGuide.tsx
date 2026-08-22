import { useState } from "react";
import { useNotes } from "../store/notes";
import { toast } from "../store/toast";
import { MarkdownImportDialog } from "./MarkdownImportDialog";

// Empty-state guidance for a fresh page: pick a page type instead of a blank editor.
export function NewPageGuide() {
  const { createDatabase } = useNotes();
  const [dismissed, setDismissed] = useState(false);
  const [importing, setImporting] = useState(false);

  const importMarkdown = () => setImporting(true);

  return (
    <>
      {!dismissed && (
        <div className="new-page-guide" onMouseDown={(e) => e.stopPropagation()}>
          <div className="new-page-guide-desc">开始编辑，或从下方选择类型</div>
          <div className="new-page-guide-options">
            <button className="new-page-guide-item" onClick={() => setDismissed(true)}>
              <span className="npg-icon">📄</span>
              <span className="npg-main">
                <span className="npg-name">页面</span>
                <span className="npg-sub">开始书写</span>
              </span>
            </button>
            <button
              className="new-page-guide-item"
              onClick={() => createDatabase(null)}
            >
              <span className="npg-icon">🗂</span>
              <span className="npg-main">
                <span className="npg-name">数据库</span>
                <span className="npg-sub">多维表 / 画廊 / 看板</span>
              </span>
            </button>
            <button
              className="new-page-guide-item"
              onClick={() => toast("模板库即将推出", "info")}
            >
              <span className="npg-icon">📑</span>
              <span className="npg-main">
                <span className="npg-name">从模板库</span>
                <span className="npg-sub">即将推出</span>
              </span>
            </button>
            <button className="new-page-guide-item" onClick={importMarkdown}>
              <span className="npg-icon">📥</span>
              <span className="npg-main">
                <span className="npg-name">导入</span>
                <span className="npg-sub">从 Markdown 导入</span>
              </span>
            </button>
            <button
              className="new-page-guide-item"
              onClick={() => toast("AI 创作即将推出", "info")}
            >
              <span className="npg-icon">✨</span>
              <span className="npg-main">
                <span className="npg-name">AI 创作</span>
                <span className="npg-sub">即将推出</span>
              </span>
            </button>
          </div>
        </div>
      )}
      {importing && <MarkdownImportDialog onClose={() => setImporting(false)} />}
    </>
  );
}
