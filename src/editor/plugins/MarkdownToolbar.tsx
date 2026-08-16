import { useCallback } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $convertFromMarkdownString, $convertToMarkdownString, TRANSFORMERS } from "@lexical/markdown";
import { $generateHtmlFromNodes } from "@lexical/html";
import { save } from "@tauri-apps/plugin-dialog";
import { $getRoot } from "lexical";
import { api } from "../../lib/api";
import { toast } from "../../store/toast";

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

export function MarkdownToolbar({ onExport }: { onExport: (markdown: string) => void }) {
  const [editor] = useLexicalComposerContext();

  const handleExport = useCallback(() => {
    editor.update(() => {
      const markdown = $convertToMarkdownString(TRANSFORMERS);
      onExport(markdown);
    });
  }, [editor, onExport]);

  const handleImport = useCallback(() => {
    const text = window.prompt("粘贴 Markdown 内容（将清空当前页面）：");
    if (text === null) return;
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      $convertFromMarkdownString(text, TRANSFORMERS, root);
    });
  }, [editor]);

  const handleExportHtml = useCallback(async () => {
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
        const title = document.querySelector(".title-input")?.getAttribute("value") || "未命名";
        html = HTML_TEMPLATE(title, body);
      });
      await api.writeTextFile(path, html);
      toast(`已导出 HTML：${path}`, "success");
    } catch (e) {
      toast(`导出失败：${e}`, "error");
    }
  }, [editor]);

  return (
    <div className="markdown-toolbar">
      <button title="导出为 Markdown" onClick={handleExport}>
        Markdown
      </button>
      <button title="导出为 HTML" onClick={handleExportHtml}>
        HTML
      </button>
      <button title="从 Markdown 导入（清空当前页）" onClick={handleImport}>
        导入
      </button>
    </div>
  );
}
