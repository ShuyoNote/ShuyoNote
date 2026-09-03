import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { CodeNode } from "@lexical/code";
import { $getNodeByKey } from "lexical";
import { toast } from "../../store/toast";

const LANGS = [
  "plain", "javascript", "typescript", "python", "java", "c", "cpp", "csharp",
  "go", "rust", "json", "html", "css", "sql", "bash", "markdown", "yaml", "xml",
];

// Per-code-block toolbar (语言选择 + 复制) + 行号 gutter. Reconciles on editor
// updates only (no polling / MutationObserver), idempotent and cheap; line count
// is derived from a DOM clone so we never re-enter editor.read() while updating.
export function CodeBlockToolbar() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    let busy = false;
    const sync = () => {
      if (busy) return;
      busy = true;
      try {
        const root = editor.getRootElement();
        const list = (root?.querySelectorAll(".editor-codeblock") ?? document.querySelectorAll(".editor-codeblock"));
        list.forEach((el) => {
          if (el instanceof HTMLElement) ensureOne(el);
        });
      } catch {
        /* ignore transient DOM issues */
      } finally {
        busy = false;
      }
    };

    const lineCount = (pre: HTMLElement): number => {
      // 克隆并剔除 gutter/工具条，避免计数被自身文本污染。
      const clone = pre.cloneNode(true) as HTMLElement;
      clone.querySelectorAll?.(".editor-code-lines, .editor-code-toolbar").forEach((x) => x.remove());
      return ((clone.textContent ?? "").match(/\n/g)?.length ?? 0) + 1;
    };

    const ensureOne = (pre: HTMLElement) => {
      // 行号 gutter。
      let lines = pre.querySelector<HTMLElement>(".editor-code-lines");
      const n = lineCount(pre);
      if (!lines) {
        lines = document.createElement("div");
        lines.className = "editor-code-lines";
        pre.appendChild(lines);
      }
      const next = Array.from({ length: n }, (_, i) => i + 1).join("\n");
      if (lines.textContent !== next) lines.textContent = next;

      // 工具条只在缺失时注入一次。
      if (pre.querySelector(".editor-code-toolbar")) return;
      const toolbar = document.createElement("div");
      toolbar.className = "editor-code-toolbar";

      const sel = document.createElement("select");
      sel.className = "editor-code-lang";
      sel.title = "切换语言";
      const key = pre.getAttribute("data-code-key");
      const lang = key ? readLang(key) : "javascript";
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
          const p = pre.getAttribute("data-code-key");
          const nn = p ? ($getNodeByKey(p) as any) : null;
          if (nn && typeof nn.setLanguage === "function") nn.setLanguage(sel.value);
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

    const readLang = (key: string): string => {
      let lang = "javascript";
      editor.getEditorState().read(() => {
        const n = $getNodeByKey(key);
        if (n && typeof (n as any).getLanguage === "function") lang = (n as any).getLanguage() ?? "javascript";
      });
      return lang;
    };

    const unregister = editor.registerUpdateListener(() => sync());
    // 初次挂载 + 节点增删。
    const unregMut = editor.registerMutationListener(CodeNode, (mutations) => {
      for (const [key2, m] of mutations) {
        if (m === "created" || m === "updated") {
          const el = editor.getElementByKey(key2);
          if (el) el.setAttribute("data-code-key", key2);
        }
      }
      sync();
    });
    sync();
    return () => {
      unregister();
      unregMut();
    };
  }, [editor]);

  return null;
}
