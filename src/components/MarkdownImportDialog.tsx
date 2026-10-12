import { useState } from "react";
import { platform } from "../lib/platform";
import { $convertFromMarkdownString } from "@lexical/markdown";
import { $getRoot } from "lexical";
import { SHUYONOTE_TRANSFORMERS, preprocessMarkdownImport } from "../editor/markdownTransformers";
import { $importHtml } from "../editor/htmlToLexical";
import { mdToHtml } from "../editor/mdToHtml";
import { api } from "../lib/api";
import { importOfficeFromPath, realOfficePathDeps } from "../lib/office/pathImport";
import { useEditorStore } from "../store/editor";
import { toast } from "../store/toast";
import { useOverlayScrollLock } from "../hooks/useOverlayScrollLock";
import { useOverlayLayer } from "../hooks/useOverlayLayer";

// Modal dialog for importing Markdown: paste or pick a file, then convert into
// the current page (replacing its content).
export function MarkdownImportDialog({ onClose }: { onClose: () => void }) {
  const editor = useEditorStore((s) => s.editor);
  const [text, setText] = useState("");
  // 父级只在需要时挂载这个组件，所以这里恒为真。
  useOverlayScrollLock();
  // Android 返回键：优先关掉最上层浮层（见 lib/overlayStack.ts）。
  useOverlayLayer("markdownImport", true, onClose);

  const importFromFile = async () => {
    try {
      const selected = await platform.dialog.open({
        // ⚠️ owner 2026-10-12（拍「甲：只把话说清」）：⭐ 老二进制 `.doc` **不在这条 filter 里** ✗
        //    ⇒ 用户**选不到它** ⇒ 那就**必须在这儿说清出路** ✓。
        //    ⛔ **不许**把 `.doc` 加进 `extensions` ✗：导入链**只解析 docx**（`importPipeline.ts:73`
        //    直连 `docxToNoteBlocks`）⇒ 加了就变成"**选得到、然后失败**" ✗（判据 `docImport.test.ts` ② 挡这个）。
        //    措辞与 `src/lib/extract/ooxml.ts:1108` **同口径** ✓（那句已经过 owner 级措辞 ⇒ ⛔ 不新造说法 ✗）。
        title: "选择要导入的文件（Markdown 或 Word 文档；⚠️ 老格式 .doc 请先用 Word/WPS「另存为 .docx」再导入）",
        filters: [
          { name: "Markdown / Word", extensions: ["md", "markdown", "txt", "docx", "docm"] },
        ],
        multiple: false,
      });
      if (!selected) return;
      const path = Array.isArray(selected) ? selected[0] : selected;
      const p = String(path);
      // ⭐ 2026-10-11（owner：「把功能加到新建页面的『从文件导入』」）：⭐ 在这儿**按类型分岔** ✗ ——
      //    ⭐ `.docx` ⇒ ⭐ 走 Office 那条**现成**的路（⭐ 原件入库 ＋ ⭐ 转换 ＋ ⭐ **建一页新笔记** ✓）；
      //    ⭐ 其余 ⇒ ⭐ 还是老路（⭐ 读文本 ⇒ ⭐ 灌进**当前**这一页 ✓）。
      //    ⚠️ 两条路的**语义故意不同** ✓：
      //       ⭐ Word ⇒ ⭐ 「直接变成一页新笔记 ✗」（⭐ 与能力页那句话一致 ✓）；
      //       ⭐ Markdown ⇒ ⭐ 「替换当前页 ✗」（⭐ 老行为**一个字没动** ✓）。
      //    ⚠️⭐ 这里**复用** `pathImport` 那条链 ✗ —— ⛔ **不许在这儿自己实现一遍解析/落库** ✓
      //       （⭐ 那就是第二份真相源 ✓，⭐ 而且判据里有一条钉着"必须复用" ✓）。
      //    ⚠️ `parentId` 给 `null` ⇒ ⭐ 新页建在**顶层** ✓（⭐ 与右下角那颗入口同口径 ✓）。
      if (/\.(docx|docm)$/i.test(p)) {
        const outcome = await importOfficeFromPath(p, null, realOfficePathDeps(null));
        toast(outcome.ok ? "已导入为新笔记" : `没导入：${outcome.message}`, outcome.ok ? "success" : "error");
        if (outcome.ok) onClose();
        return;
      }
      const content = await api.readTextFile(p);
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
