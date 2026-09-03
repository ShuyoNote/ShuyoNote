import { useEffect, useState } from "react";
import { $convertToMarkdownString } from "@lexical/markdown";
import { $generateHtmlFromNodes } from "@lexical/html";
import { platform } from "../lib/platform";
import { api } from "../lib/api";
import { useEditorStore } from "../store/editor";
import { useViewStore } from "../store/view";
import { useTemplates } from "../store/templates";
import { toast } from "../store/toast";
import { HistoryPanel } from "./HistoryPanel";
import { DownloadIcon, FileCodeIcon, PrintIcon, SearchIcon, UploadIcon, ContentWidthIcon, TemplateIcon } from "./icons";
import { SHUYONOTE_TRANSFORMERS } from "../editor/markdownTransformers";
import { MarkdownImportDialog } from "./MarkdownImportDialog";
import { docHtml, printDoc } from "../lib/print";

function triggerFind() {
  // The find bar listens for Ctrl+F on document; simulate it.
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true }),
  );
}

export function EditorToolbar({ pageId }: { pageId: string }) {
  const editor = useEditorStore((s) => s.editor);
  const [importing, setImporting] = useState(false);
  const contentWidth = useViewStore((s) => s.contentWidth);
  const setContentWidth = useViewStore((s) => s.setContentWidth);
  const [exportOpen, setExportOpen] = useState(false);

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
      const path = await platform.dialog.save({
        title: "导出 HTML",
        defaultPath: "note.html",
        filters: [{ name: "HTML", extensions: ["html"] }],
      });
      if (!path) return;
      let html = "";
      editor.read(() => {
        const body = $generateHtmlFromNodes(editor);
        const title = (document.querySelector(".title-input") as HTMLInputElement | null)?.value || "未命名";
        html = docHtml(body, { title });
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
      printDoc(body, { title });
    });
  };

  const importMarkdown = () => setImporting(true);

  const saveAsTemplate = async () => {
    try {
      const page = await api.getPage(pageId);
      if (!page || (page.kind !== "page" && page.kind !== "database")) {
        toast("当前不是可保存为模板的页面", "error");
        return;
      }
      const ok = await useTemplates
        .getState()
        .saveAs({ name: page.title || "未命名", content_json: page.content_json, content_text: page.content_text, cover: page.cover, icon: page.icon });
      if (ok) toast(`已保存为模板「${page.title || "未命名"}」`, "success");
      else toast("保存失败", "error");
    } catch (e) {
      toast(`保存失败：${e}`, "error");
    }
  };

  return (
    <div className="editor-toolbar">
      <button className="toolbar-btn" onClick={triggerFind} title="查找 (Ctrl+F)">
        <SearchIcon />
      </button>
      <button className="toolbar-btn" onClick={importMarkdown} title="从 Markdown 导入">
        <UploadIcon />
      </button>
      <button className="toolbar-btn" onClick={saveAsTemplate} title="把当前页保存为模板（我的模板）">
        <TemplateIcon />
      </button>
      <button
        className={`toolbar-btn ${contentWidth === "full" ? "active" : ""}`}
        onClick={toggleWidth}
        title={contentWidth === "full" ? "内容宽度：自适应（点击恢复居中）" : "内容宽度：居中（点击自适应全宽）"}
      >
        <ContentWidthIcon />
      </button>
      <div className="editor-toolbar-more">
        <button
          className="toolbar-btn"
          onClick={() => setExportOpen((v) => !v)}
          title="更多（导出等）"
        >
          ⋯
        </button>
        {exportOpen && (
          <div className="editor-more-menu">
            <button className="toolbar-menu-item" onClick={() => { setExportOpen(false); exportMarkdown(); }} title="导出为 Markdown">
              <DownloadIcon /> 导出 Markdown
            </button>
            <button className="toolbar-menu-item" onClick={() => { setExportOpen(false); exportHtml(); }} title="导出为 HTML">
              <FileCodeIcon /> 导出 HTML
            </button>
            <button className="toolbar-menu-item" onClick={() => { setExportOpen(false); exportPdf(); }} title="导出为 PDF">
              <PrintIcon /> 导出 PDF
            </button>
          </div>
        )}
      </div>
      <HistoryPanel pageId={pageId} />
      {importing && <MarkdownImportDialog onClose={() => setImporting(false)} />}
    </div>
  );
}
