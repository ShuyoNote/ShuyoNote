import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $generateNodesFromDOM } from "@lexical/html";
import { $insertNodes, COMMAND_PRIORITY_HIGH, PASTE_COMMAND } from "lexical";

import { cleanPastedCodeHtml } from "../pasteClean";

/**
 * 富文档粘贴的**代码块行号清理**（2026-11-04 owner 截图：代码块正文里又带了一套行号）。
 *
 * 只在剪贴板 HTML 里**确实有 `<pre>` 且能算出“连续序号行号”** 时接管这次粘贴：
 * 清掉行号后，用 Lexical 自己的 DOM 导入重新生成节点（保留段落/表格/链接等），
 * ⛔ 不是把整篇当纯文本粘贴。
 */
export function CodePasteCleanPlugin() {
  const [editor] = useLexicalComposerContext();
  useEffect(
    () =>
      editor.registerCommand(
        PASTE_COMMAND,
        (event) => {
          const e = event as ClipboardEvent;
          // 图片粘贴交给 ImagePastePlugin（这里只处理“代码块行号”这一种 HTML）。
          if (e.clipboardData && Array.from(e.clipboardData.items).some((i) => i.type.startsWith("image/"))) {
            return false;
          }
          const html = e.clipboardData?.getData("text/html") ?? "";
          if (!html || !/<pre[\s>]/i.test(html)) return false;
          const cleaned = cleanPastedCodeHtml(html);
          if (!cleaned) return false;

          e.preventDefault();
          const doc = new DOMParser().parseFromString(cleaned, "text/html");
          editor.update(() => {
            $insertNodes($generateNodesFromDOM(editor, doc));
          });
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
    [editor],
  );
  return null;
}
