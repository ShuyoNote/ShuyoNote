import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { CodeNode } from "@lexical/code";
import { $getRoot, $getNodeByKey } from "lexical";
import { toast } from "../../store/toast";

const LANGS = [
  "plain", "javascript", "typescript", "python", "java", "c", "cpp", "csharp",
  "go", "rust", "json", "html", "css", "sql", "bash", "markdown", "yaml", "xml",
];

// Per-code-block toolbar (语言选择 + 复制) + 行号 gutter, injected into the
// real Lexical DOM via editor.getElementByKey. Runs on editor update (DOM ready)
// with a small debounce; idempotent and never triggers an editor.update.
export function CodeBlockToolbar() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    const lineCount = (pre: HTMLElement): number => {
      const clone = pre.cloneNode(true) as HTMLElement;
      clone.querySelectorAll?.(".editor-code-lines, .editor-code-toolbar").forEach((x) => x.remove());
      return ((clone.textContent ?? "").match(/\n/g)?.length ?? 0) + 1;
    };

    const ensureOne = (pre: HTMLElement) => {
      let lines = pre.querySelector<HTMLElement>(".editor-code-lines");
      const n = lineCount(pre);
      if (!lines) {
        lines = document.createElement("div");
        lines.className = "editor-code-lines";
        pre.appendChild(lines);
      }
      const next = Array.from({ length: n }, (_, i) => i + 1).join("\n");
      if (lines.textContent !== next) lines.textContent = next;

      if (pre.querySelector(".editor-code-toolbar")) return;
      const key = pre.getAttribute("data-code-key");
      const toolbar = document.createElement("div");
      toolbar.className = "editor-code-toolbar";

      const sel = document.createElement("select");
      sel.className = "editor-code-lang";
      sel.title = "切换语言";
      const lang = key ? readLang(key) : "javascript";
      LANGS.forEach((l) => {
        const o = document.createElement("option");
        o.value = l;
        o.textContent = l;
        if (l === lang) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener("change", () => {
        const p = pre.getAttribute("data-code-key");
        if (!p) return;
        editor.update(() => {
          const nn = ($getNodeByKey(p) as any) ?? null;
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
      try {
        editor.getEditorState().read(() => {
          const n = ($getNodeByKey(key) as any) ?? null;
          if (n && typeof n.getLanguage === "function") lang = n.getLanguage() ?? "javascript";
        });
      } catch {
        /* ignore */
      }
      return lang;
    };

    const applyAll = () => {
      try {
        const root = editor.getRootElement();
        if (!root) return;
        // 代码块在编辑器里就是 <pre>（不依赖 class/节点遍历）。
        root.querySelectorAll("pre").forEach((pre) => {
          if (pre instanceof HTMLElement) ensureOne(pre);
        });
      } catch {
        /* ignore */
      }
    };

    let timer: number | null = null;
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        applyAll();
      }, 60);
    };

    const unreg = editor.registerUpdateListener(schedule);
    // 初次挂载也跑一次（等一帧确保 DOM 就绪）。
    applyAll();
    return () => {
      unreg();
      if (timer) clearTimeout(timer);
    };
  }, [editor]);

  return null;
}
