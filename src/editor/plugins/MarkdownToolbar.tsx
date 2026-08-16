import { useCallback } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $convertFromMarkdownString, $convertToMarkdownString, TRANSFORMERS } from "@lexical/markdown";
import { $getRoot } from "lexical";

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

  return (
    <div className="markdown-toolbar">
      <button title="导出为 Markdown" onClick={handleExport}>
        导出 Markdown
      </button>
      <button title="从 Markdown 导入（清空当前页）" onClick={handleImport}>
        导入 Markdown
      </button>
    </div>
  );
}
