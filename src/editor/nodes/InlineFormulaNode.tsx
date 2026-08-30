// M26 公式 — inline `$...$` math. Extends TextNode so it participates in text flow
// and keeps `$...$` as its literal text (content_text stays searchable/exportable).
// The rendered KaTeX is visual; editing is done by editing the literal `$...$`
// (the registerNodeTransform re-renders on change). KaTeX is loaded lazily.
import {
  $applyNodeReplacement,
  TextNode,
  type EditorConfig,
  type NodeKey,
  type SerializedTextNode,
  type Spread,
} from "lexical";

export type SerializedInlineFormulaNode = Spread<
  { latex: string; type: string; version: number },
  SerializedTextNode
>;

export class InlineFormulaNode extends TextNode {
  __latex: string;

  static getType(): string {
    return "inline-formula";
  }

  static clone(node: InlineFormulaNode): InlineFormulaNode {
    return new InlineFormulaNode(node.__text, node.__latex, node.__key);
  }

  constructor(text: string, latex: string, key?: NodeKey) {
    super(text, key);
    this.__latex = latex;
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const span = document.createElement("span");
    span.className = "editor-inline-formula";
    span.setAttribute("data-latex", this.__latex);
    // Render KaTeX lazily; fall back to the source text if it fails.
    const host = document.createElement("span");
    host.className = "editor-inline-formula-katex";
    span.appendChild(host);
    import("katex/dist/katex.min.css")
      .then(() => import("katex"))
      .then((mod) => {
        mod.default.render(this.__latex, host, { displayMode: false, throwOnError: false, output: "html" });
      })
      .catch(() => {
        host.textContent = this.__latex;
      });
    return span;
  }

  updateDOM(): boolean {
    // We manage the KaTeX content ourselves; never let Lexical overwrite it.
    return false;
  }

  exportJSON(): SerializedInlineFormulaNode {
    return {
      ...super.exportJSON(),
      type: "inline-formula",
      version: 1,
      latex: this.__latex,
    };
  }

  static importJSON(serializedNode: SerializedInlineFormulaNode): InlineFormulaNode {
    const node = $createInlineFormulaNode(
      serializedNode.text || `$${serializedNode.latex}$`,
      serializedNode.latex,
    );
    node.setFormat(serializedNode.format);
    node.setDetail(serializedNode.detail);
    node.setMode(serializedNode.mode);
    node.setStyle(serializedNode.style);
    return node;
  }
}

export function $createInlineFormulaNode(text: string, latex: string): InlineFormulaNode {
  const safeText = text.startsWith("$") ? text : `$${latex}$`;
  return $applyNodeReplacement(new InlineFormulaNode(safeText, latex));
}

export function $isInlineFormulaNode(node: unknown): node is InlineFormulaNode {
  return node instanceof InlineFormulaNode;
}
