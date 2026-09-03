import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { CodeNode } from "@lexical/code";
import { $getNodeByKey } from "lexical";
import { toast } from "../../store/toast";

const LANGS = [
  "plain", "javascript", "typescript", "python", "java", "c", "cpp", "csharp",
  "go", "rust", "json", "html", "css", "sql", "bash", "markdown", "yaml", "xml",
];

// Per-code-block toolbar (语言选择 + 复制) + 行号 gutter. Injected into the
// Lexical-owned `<pre class="editor-codeblock">`; on any code update the pre's
// children are rewritten by Lexical, so we re-assert on each update via the
// mutation listener + a MutationObserver.
export function CodeBlockToolbar() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    const readLang = (key: string | null): string => {
      if (!key) return "javascript";
      return editor.getEditorState().read(() => {
        const n = $getNodeByKey(key) as any;
        return n && typeof n.getLanguage === "function" ? (n.getLanguage() ?? "javascript") : "javascript";
      });
    };

    const ensureOne = (pre: HTMLElement) => {
      // 行号 gutter（1..N）。
      if (!pre.querySelector(".editor-code-lines")) {
        const txt = pre.innerText ?? pre.textContent ?? "";
        const n = (txt.match(/\n/g)?.length ?? 0) + 1;
        const lines = document.createElement("div");
        lines.className = "editor-code-lines";
        lines.textContent = Array.from({ length: n }, (_, i) => i + 1).join("\n");
        pre.appendChild(lines);
      }
      // 工具条。
      if (pre.querySelector(".editor-code-toolbar")) return;
      const key = pre.getAttribute("data-code-key");
      const toolbar = document.createElement("div");
      toolbar.className = "editor-code-toolbar";

      const sel = document.createElement("select");
      sel.className = "editor-code-lang";
      sel.title = "切换语言";
      const lang = readLang(key);
      LANGS.forEach((l) => {
        const o = document.createElement("option");
        o.value = l;
        o.textContent = l;
        if (l === lang) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener("change", () => {
        if (!key) return;
        editor.update(() => {
          const n = $getNodeByKey(key) as any;
          if (n && typeof n.setLanguage === "function") n.setLanguage(sel.value);
        });
      });

      const copy = document.createElement("button");
      copy.className = "editor-code-copy";
      copy.textContent = "复制";
      copy.title = "复制代码";
      copy.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const txt = pre.querySelector("code")?.textContent ?? pre.textContent ?? "";
        navigator.clipboard
          .writeText(txt)
          .then(() => toast("已复制代码", "success"))
          .catch(() => toast("复制失败", "error"));
      });

      toolbar.appendChild(sel);
      toolbar.appendChild(copy);
      pre.appendChild(toolbar);
    };

    const ensureAll = () => {
      const root = editor.getRootElement();
      const list = (root?.querySelectorAll(".editor-codeblock") ?? document.querySelectorAll(".editor-codeblock"));
      list.forEach((el) => {
        if (el instanceof HTMLElement) ensureOne(el);
      });
    };

    const unregister = editor.registerMutationListener(CodeNode, (mutations) => {
      for (const [nodeKey, mutation] of mutations) {
        if (mutation === "created" || mutation === "updated") {
          const el = editor.getElementByKey(nodeKey);
          if (el) el.setAttribute("data-code-key", nodeKey);
        }
      }
      ensureAll();
    });
    ensureAll();
    const id = window.setInterval(ensureAll, 500);
    const root = editor.getRootElement();
    const mo = root ? new MutationObserver(() => ensureAll()) : null;
    if (mo && root) mo.observe(root, { childList: true, subtree: true });
    return () => {
      unregister();
      clearInterval(id);
      mo?.disconnect();
    };
  }, [editor]);

  return null;
}
