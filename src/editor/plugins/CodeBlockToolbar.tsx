import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { CodeNode } from "@lexical/code";
import { $getNodeByKey } from "lexical";
import { toast } from "../../store/toast";

const LANGS = [
  "plain", "javascript", "typescript", "python", "java", "c", "cpp", "csharp",
  "go", "rust", "json", "html", "css", "sql", "bash", "markdown", "yaml", "xml",
];

// Injects a per-code-block toolbar (语言选择 + 复制) into each `.editor-code`,
// reusing Lexical's owned DOM without disturbing the code/token subtree.
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

    const ensure = () => {
      document.querySelectorAll<HTMLElement>(".editor-codeblock").forEach((pre) => {
        if ((pre as any)._snToolbar) return;
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
          const txt = pre.querySelector("code")?.textContent ?? "";
          navigator.clipboard
            .writeText(txt)
            .then(() => toast("已复制代码", "success"))
            .catch(() => toast("复制失败", "error"));
        });

        toolbar.appendChild(sel);
        toolbar.appendChild(copy);
        pre.appendChild(toolbar);
        (pre as any)._snToolbar = true;
      });
    };

    const unregister = editor.registerMutationListener(CodeNode, (mutations) => {
      for (const [nodeKey, mutation] of mutations) {
        if (mutation === "created" || mutation === "updated") {
          const el = editor.getElementByKey(nodeKey);
          if (el) el.setAttribute("data-code-key", nodeKey);
        }
      }
      ensure();
    });
    ensure();
    const id = window.setInterval(ensure, 500);
    return () => {
      unregister();
      clearInterval(id);
    };
  }, [editor]);

  return null;
}
