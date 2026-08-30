// M26 公式 — a block-level math formula. Input `$$...$$` (or `/公式`) renders to a
// display-mode KaTeX expression, sits as an opaque block like MermaidNode/DrawingNode,
// and its LaTeX source goes into `content_text` so it's searchable. KaTeX is loaded
// lazily (code-split into its own chunk) so it never touches the first-paint bundle.
import {
  $applyNodeReplacement,
  DecoratorNode,
  type DOMExportOutput,
  type EditorConfig,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from "lexical";
import { Suspense, useCallback, useEffect, useRef } from "react";
import type { JSX } from "react";
import { useEditorStore } from "../../store/editor";
import { openFormulaEditor } from "../../store/formulaEditor";

export type SerializedFormulaNode = Spread<
  { latex: string },
  SerializedLexicalNode
>;

// Lazy renderer component: dynamically imports KaTeX the first time a formula is
// shown, then renders into a stable <span>.
function FormulaView({ latex, node }: { latex: string; node: FormulaNode }) {
  const hostRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // Lexical wraps every decorator in a RichTextPlugin ErrorBoundary div
    // (.editor-error, which inherits the editor's contenteditable). Force it (and
    // everything up to our container) non-editable so clicks can't focus/type into
    // the formula block. Re-apply on each render in case Lexical re-mounts it.
    const ceTarget = host.closest(".editor-error, .editor-formula-container");
    if (ceTarget) ceTarget.setAttribute("contenteditable", "false");
    // Block mouse-down default (caret placement) on the whole Lexical-wrapped
    // container so a click inside the formula area never drops the caret there.
    const container = ceTarget ?? host;
    const onMd = (e: Event) => e.preventDefault();
    container.addEventListener("mousedown", onMd);
    // Use the React-rendered katex span as the KaTeX target (don't create a second).
    const child = host.querySelector<HTMLElement>(".editor-formula-katex");
    import("katex/dist/katex.min.css")
      .then(() => import("katex"))
      .then((mod) => {
        if (child) mod.default.render(latex, child, { displayMode: true, throwOnError: false, output: "html" });
      })
      .catch(() => {
        if (child) child.textContent = latex;
      });
    return () => container.removeEventListener("mousedown", onMd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latex]);

  const edit = useCallback(() => {
    const editor = useEditorStore.getState().editor;
    const rect = hostRef.current?.getBoundingClientRect();
    const anchor = rect
      ? { top: rect.bottom, left: rect.left, width: rect.width, height: rect.height }
      : null;
    openFormulaEditor({
      initial: node.__latex,
      original: node.__latex,
      anchor,
      // Live-preview each keystroke onto the editor's formula block so the page
      // formula updates in real time (not just an in-dialog preview).
      livePreview: (latex) => {
        if (editor && latex) editor.update(() => node.setFormula(latex));
      },
      onCommit: (v) => {
        if (v && editor) editor.update(() => node.setFormula(v));
      },
    });
  }, [node]);

  return (
    <span className="editor-formula-wrap" contentEditable={false} onMouseDown={(e) => e.preventDefault()}>
      <button
        ref={hostRef}
        className="editor-formula"
        contentEditable={false}
        onMouseDown={(e) => e.preventDefault()}
        title={`${latex} · 点击编辑`}
        onClick={(e) => {
          e.stopPropagation();
          edit();
        }}
      >
        <span className="editor-formula-katex" aria-label={latex} contentEditable={false} />
      </button>
    </span>
  );
}

export class FormulaNode extends DecoratorNode<JSX.Element> {
  __latex: string;

  static getType(): string {
    return "formula";
  }

  static clone(node: FormulaNode): FormulaNode {
    return new FormulaNode(node.__latex, node.__key);
  }

  constructor(latex = "", key?: NodeKey) {
    super(key);
    this.__latex = latex;
  }

  $config() {
    return this.config("formula", { extends: DecoratorNode<JSX.Element> });
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const span = document.createElement("span");
    span.className = "editor-formula-container";
    span.setAttribute("contentEditable", "false");
    span.setAttribute("data-lexical-decorator", "true");
    return span;
  }
  updateDOM(): boolean {
    return false;
  }

  setFormula(latex: string): void {
    const writable = this.getWritable();
    writable.__latex = latex;
  }

  getTextContent(): string {
    return this.__latex;
  }

  decorate(): JSX.Element {
    return (
      <Suspense fallback={<div className="editor-formula-loading">加载公式…</div>}>
        <FormulaView latex={this.__latex} node={this} />
      </Suspense>
    );
  }

  exportDOM(_editor: LexicalEditor): DOMExportOutput {
    const el = document.createElement("div");
    el.textContent = `$$${this.__latex}$$`;
    return { element: el };
  }

  exportJSON(): SerializedFormulaNode {
    return {
      ...super.exportJSON(),
      type: "formula",
      version: 1,
      latex: this.__latex,
    };
  }

  static importJSON(serializedNode: SerializedFormulaNode): FormulaNode {
    return $createFormulaNode(serializedNode.latex ?? "");
  }
}

export function $createFormulaNode(latex: string): FormulaNode {
  return $applyNodeReplacement(new FormulaNode(latex));
}

export function $isFormulaNode(node: LexicalNode | null | undefined): node is FormulaNode {
  return node instanceof FormulaNode;
}
