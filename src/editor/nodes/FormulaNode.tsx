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
import { blockIdOf, blockRevOf, withBlockId, withBlockRev } from "./blockIdHelpers";

export type SerializedFormulaNode = Spread<
  { latex: string; blockId?: string; blockRev?: number },
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
  /** 块身份（只有**顶层块**才有；见 docs/plans/2026-09-18-crdt-block-id-ownership.md）。 */
  __blockId: string;
  /** 声明式块版本（Lamport）；`null` = 没有/不认识这个字段（缺字段 = 老客户端产物）。 */
  __blockRev: number | null;

  static getType(): string {
    return "formula";
  }

  static clone(node: FormulaNode): FormulaNode {
    return new FormulaNode(node.__latex, node.__blockId, node.__key, node.__blockRev);
  }
  constructor(latex = "", blockId = "", key?: NodeKey, blockRev: number | null = null) {
    super(key);
    this.__latex = latex;
    this.__blockId = blockId;
    this.__blockRev = blockRev;
  }

  afterCloneFrom(prevNode: this): void {
    super.afterCloneFrom(prevNode);
    this.__blockId = (prevNode as FormulaNode).__blockId;
    this.__blockRev = (prevNode as FormulaNode).__blockRev;
  }

  getBlockId(): string {
    return this.__blockId;
  }

  setBlockId(blockId: string): void {
    const writable = this.getWritable();
    writable.__blockId = blockId;
  }

  getBlockRev(): number | null {
    return this.__blockRev;
  }

  setBlockRev(blockRev: number | null): void {
    const writable = this.getWritable();
    writable.__blockRev = blockRev;
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
    return withBlockRev(
      withBlockId(
        {
          ...super.exportJSON(),
          type: "formula",
          version: 1,
          latex: this.__latex,
        },
        this.__blockId,
      ),
      this.__blockRev,
    );
  }

  static importJSON(serializedNode: SerializedFormulaNode): FormulaNode {
    // rev 走**工厂参数**（与 `blockId` 同一条路）：解析出来的节点还没进编辑器状态，直接经构造参数
    // 带上比"先造再 set"少一次 `getWritable()` 克隆。`setBlockRev` 仍然保留（挂上编辑器之后用它）。
    return $createFormulaNode(serializedNode.latex ?? "", blockIdOf(serializedNode), blockRevOf(serializedNode));
  }
}

export function $createFormulaNode(latex: string, blockId?: string, blockRev: number | null = null): FormulaNode {
  return $applyNodeReplacement(new FormulaNode(latex, blockId ?? "", undefined, blockRev));
}

export function $isFormulaNode(node: LexicalNode | null | undefined): node is FormulaNode {
  return node instanceof FormulaNode;
}
