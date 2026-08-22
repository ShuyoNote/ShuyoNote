import { useEffect, useState } from "react";
import { $convertToMarkdownString } from "@lexical/markdown";
import { $generateHtmlFromNodes } from "@lexical/html";
import { save } from "@tauri-apps/plugin-dialog";
import { api } from "../lib/api";
import { useEditorStore } from "../store/editor";
import { useViewStore } from "../store/view";
import { toast } from "../store/toast";
import { HistoryPanel } from "./HistoryPanel";
import { DownloadIcon, FileCodeIcon, PrintIcon, SearchIcon, UploadIcon } from "./icons";
import { SHUYONOTE_TRANSFORMERS } from "../editor/markdownTransformers";
import { MarkdownImportDialog } from "./MarkdownImportDialog";

const HTML_TEMPLATE = (title: string, body: string) => `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${title}</title>
<style>
  body { max-width: 720px; margin: 40px auto; padding: 0 24px; font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; line-height: 1.7; color: #1f2329; }
  h1 { font-size: 1.8em; margin: 0.6em 0 0.3em; }
  h2 { font-size: 1.4em; margin: 0.5em 0 0.25em; }
  h3 { font-size: 1.15em; margin: 0.4em 0 0.2em; }
  blockquote { border-left: 3px solid #d4d8df; padding-left: 12px; color: #646a73; margin: 0.5em 0; }
  code { background: #f2f3f5; border-radius: 4px; padding: 1px 4px; font-family: Consolas, monospace; font-size: 0.9em; }
  pre { background: #f7f8fa; border: 1px solid #e5e8ee; border-radius: 6px; padding: 12px; overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; margin: 0.5em 0; }
  th, td { border: 1px solid #e5e8ee; padding: 6px 10px; }
  img { max-width: 100%; border-radius: 6px; }
  hr { border: none; border-top: 1px solid #e5e8ee; margin: 1em 0; }
</style>
</head>
<body>
${body}
</body>
</html>`;

function triggerFind() {
  // The find bar listens for Ctrl+F on document; simulate it.
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true }),
  );
}

// Render an HTML document into a hidden iframe and trigger the system print
// dialog (user can "Save as PDF"). Works in WebView2.
function printHTML(html: string) {
  const iframe = document.createElement("iframe");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument;
  if (!doc) return;
  doc.open();
  doc.write(html);
  doc.close();
  iframe.contentWindow?.focus();
  iframe.contentWindow?.print();
  setTimeout(() => iframe.remove(), 1200);
}

export function EditorToolbar({ pageId }: { pageId: string }) {
  const editor = useEditorStore((s) => s.editor);
  const [importing, setImporting] = useState(false);
  const contentWidth = useViewStore((s) => s.contentWidth);
  const setContentWidth = useViewStore((s) => s.setContentWidth);

  // Apply the adaptive-width body class so content fills the available width.
  useEffect(() => {
    document.body.classList.toggle("content-full", contentWidth === "full");
    return () => document.body.classList.remove("content-full");
  }, [contentWidth]);

  const toggleWidth = () =>
    setContentWidth(contentWidth === "full" ? "centered" : "full");

  const exportMarkdown = () => {
    if (!editor) return;
    editor.update(() => {
      const markdown = $convertToMarkdownString(SHUYONOTE_TRANSFORMERS);
      navigator.clipboard
        .writeText(markdown)
        .then(() => toast("已复制 Markdown 到剪贴板", "success"))
        .catch(() => toast("复制失败", "error"));
    });
  };

  const exportHtml = async () => {
    if (!editor) return;
    try {
      const path = await save({
        title: "导出 HTML",
        defaultPath: "note.html",
        filters: [{ name: "HTML", extensions: ["html"] }],
      });
      if (!path) return;
      let html = "";
      editor.read(() => {
        const body = $generateHtmlFromNodes(editor);
        const title = (document.querySelector(".title-input") as HTMLInputElement | null)?.value || "未命名";
        html = HTML_TEMPLATE(title, body);
      });
      await api.writeTextFile(path, html);
      toast("已导出 HTML", "success");
    } catch (e) {
      toast(`导出失败：${e}`, "error");
    }
  };

  const exportPdf = () => {
    if (!editor) return;
    editor.read(() => {
      const body = $generateHtmlFromNodes(editor);
      const title = (document.querySelector(".title-input") as HTMLInputElement | null)?.value || "未命名";
      printHTML(HTML_TEMPLATE(title, body));
    });
  };

  const importMarkdown = () => setImporting(true);

  return (
    <div className="editor-toolbar">
      <button className="toolbar-btn" onClick={triggerFind} title="查找 (Ctrl+F)">
        <SearchIcon />
      </button>
      <button className="toolbar-btn" onClick={importMarkdown} title="从 Markdown 导入">
        <UploadIcon />
      </button>
      <button className="toolbar-btn" onClick={exportMarkdown} title="导出为 Markdown">
        <DownloadIcon />
      </button>
      <button className="toolbar-btn" onClick={exportHtml} title="导出为 HTML">
        <FileCodeIcon />
      </button>
      <button className="toolbar-btn" onClick={exportPdf} title="导出为 PDF（打印 → 另存为 PDF）">
        <PrintIcon />
      </button>
      <button
        className={`toolbar-btn ${contentWidth === "full" ? "active" : ""}`}
        onClick={toggleWidth}
        title={contentWidth === "full" ? "内容宽度：自适应（点击恢复居中）" : "内容宽度：居中（点击自适应全宽）"}
      >
        ⇔
      </button>
      <HistoryPanel pageId={pageId} />
      {importing && <MarkdownImportDialog onClose={() => setImporting(false)} />}
    </div>
  );
}
