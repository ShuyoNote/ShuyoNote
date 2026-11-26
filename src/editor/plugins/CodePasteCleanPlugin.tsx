import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $createLineBreakNode,
  $createTextNode,
  $insertNodes,
  COMMAND_PRIORITY_HIGH,
  PASTE_COMMAND,
} from "lexical";
import { $createCodeNode } from "@lexical/code";

import { codePasteFromHtml } from "../pasteClean";

/**
 * 富文档粘贴的**代码块行号清理**（2026-11-04 owner 截图：代码块正文里又带了一套行号）。
 *
 * ⭐ **2026-11-26（owner 截图：粘进来的代码块出现**两列行号**）**：改成**一律由这里接管 `<pre>` 粘贴**，
 * 直接造**一个**代码块（⛔ 不再走 `$generateNodesFromDOM` 的 `<pre>` 导入）。
 *
 * 为什么（真机双证：截图 + 库里结构 `code > code > code-highlight`）：
 * Lexical 的 `<pre>` 导入会把 `<pre><code>…</code></pre>` 导成**代码块里套代码块**，
 * 而 `CodeBlockToolbar` 是**按元素**给每个 `.editor-codeblock` 画行号栏的 ⇒ 外层一列、内层一列 = **两列**。
 * 由我们接管后：一个 `<pre>` ⇒ **恰好一个 code 节点**，行号只可能有一列。
 *
 * 口径：文本取第一个 `<pre>` 的 textContent（先过行号清理）；语言取 `data-language` / `language-*`。
 * ⛔ 不碰非 `<pre>` 的富文本粘贴（那些照旧交给 Lexical）。
 */
export function CodePasteCleanPlugin() {
  const [editor] = useLexicalComposerContext();
  useEffect(
    () =>
      editor.registerCommand(
        PASTE_COMMAND,
        (event) => {
          const e = event as ClipboardEvent;
          // 图片粘贴交给 ImagePastePlugin（这里只处理代码块）。
          if (e.clipboardData && Array.from(e.clipboardData.items).some((i) => i.type.startsWith("image/"))) {
            return false;
          }
          const html = e.clipboardData?.getData("text/html") ?? "";
          if (!html || !/<pre[\s>]/i.test(html)) return false;
          const code = codePasteFromHtml(html);
          if (!code) return false;

          e.preventDefault();
          editor.update(() => {
            const node = $createCodeNode(code.language);
            const lines = code.text.split("\n");
            lines.forEach((line, i) => {
              if (i > 0) node.append($createLineBreakNode());
              if (line !== "") node.append($createTextNode(line));
            });
            $insertNodes([node]);
          });
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
    [editor],
  );
  return null;
}
