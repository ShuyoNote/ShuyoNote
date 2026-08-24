import { useState } from "react";
import { platform } from "../lib/platform";
import { $convertFromMarkdownString } from "@lexical/markdown";
import { $getRoot } from "lexical";
import { SHUYONOTE_TRANSFORMERS, preprocessMarkdownImport } from "../editor/markdownTransformers";
import { $importHtml } from "../editor/htmlToLexical";
import { mdToHtml } from "../editor/mdToHtml";
import { api } from "../lib/api";
import { useEditorStore } from "../store/editor";
import { toast } from "../store/toast";

// Modal dialog for importing Markdown: paste or pick a file, then convert into
// the current page (replacing its content).
export function MarkdownImportDialog({ onClose }: { onClose: () => void }) {
  const editor = useEditorStore((s) => s.editor);
  const [text, setText] = useState("");

  const importFromFile = async () => {
    try {
      const selected = await platform.dialog.open({
        title: "选择 Markdown 文件",
        filters: [
          { name: "Markdown", extensions: ["md", "markdown", "txt"] },
        ],
        multiple: false,
      });
      if (!selected) return;
      const path = Array.isArray(selected) ? selected[0] : selected;
      const content = await api.readTextFile(path as string);
      setText(content);
    } catch (e) {
      toast(`读取文件失败：${e}`, "error");
    }
  };

  const doImport = () => {
    if (!editor) return;
    if (!text.trim()) {
      toast("内容为空，请粘贴或从文件导入", "info");
      return;
    }
    let ok = false;
    try {
      // Elegant routing. Pure Markdown has no block HTML → lossless
      // $convertFromMarkdownString (round-trip preserved). Any content that
      // contains block HTML (a GitHub README, for instance) is first normalised:
      // Markdown constructs are converted to HTML (mdToHtml) and the existing
      // inline HTML (align="center", <img>, <br>…) is passed through, then the
      // whole document is imported direct-to-Lexical so structure is preserved
      // (badges stay inline in a centered paragraph instead of stacking).
      const hasBlockHtml = /<(p|h[1-6]|div|img|table|ul|ol|li|blockquote|pre|hr|section|article|iframe)\b/i.test(text);
      editor.update(() => {
        const root = $getRoot();
        root.clear();
        if (hasBlockHtml) {
          $importHtml(mdToHtml(text), root);
        } else {
          $convertFromMarkdownString(preprocessMarkdownImport(text), SHUYONOTE_TRANSFORMERS, root);
        }
      });
      ok = true;
    } catch (e) {
      toast(`导入失败：${e}`, "error");
    }
    if (ok) {
      toast("已从 Markdown 导入", "success");
      onClose();
    }
  };

  return (
    <div
      className="markdown-import-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="markdown-import">
        <div className="markdown-import-title">从 Markdown 导入</div>
        <textarea
          className="markdown-import-textarea"
          placeholder="粘贴 Markdown 内容…（将替换当前页面内容）"
          value={text}
          onChange={(e) => setText(e.target.value)}
          autoFocus
        />
        <div className="markdown-import-actions">
          <button className="markdown-import-file" onClick={importFromFile}>
            从文件导入
          </button>
          <div className="markdown-import-spacer" />
          <button className="markdown-import-cancel" onClick={onClose}>
            取消
          </button>
          <button className="markdown-import-confirm" onClick={doImport}>
            导入
          </button>
        </div>
      </div>
    </div>
  );
}
