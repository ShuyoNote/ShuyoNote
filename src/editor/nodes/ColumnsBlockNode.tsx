import {
  $applyNodeReplacement,
  DecoratorNode,
  $getNodeByKey,
  type DOMExportOutput,
  type EditorConfig,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from "lexical";
import type { JSX } from "react";
import { lazy, Suspense } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { useNotes } from "../../store/notes";

// Lazy-load the view so the static import chain never pulls config.ts back in
// (config.ts imports this node for EDITOR_NODES, so a static view import would be a
// circular dependency that breaks EDITOR_NODES evaluation).
const ColumnsBlockView = lazy(() =>
  import("../../components/ColumnsBlockView").then((m) => ({ default: m.ColumnsBlockView })),
);

// Route B: a columns block is a DecoratorNode that stores N columns, each as its
// OWN serialized EditorState JSON (a full block stack), rendered by ColumnsBlockView
// as N independent nested editors. `cols.length` = column count.

export type SerializedColumnsBlockNode = Spread<
  { count: number; cols: string[] },
  SerializedLexicalNode
>;

// An empty column's serialized EditorState (a single empty paragraph with an empty
// text node — Lexical's natural shape for a fresh block, so list/selection commands
// resolve points reliably; a zero-children paragraph can trip selection invariants).
export const EMPTY_COLUMN_JSON = JSON.stringify({ root: { children: [{ type: "paragraph", version: 1, indent: 0, direction: "ltr", format: "", children: [{ type: "text", text: "", version: 1 }] }], type: "root", version: 1 } });
const EMPTY_COL = EMPTY_COLUMN_JSON;

export class ColumnsBlockNode extends DecoratorNode<JSX.Element> {
  __cols: string[];

  static getType(): string {
    return "columnsBlock";
  }

  static clone(node: ColumnsBlockNode): ColumnsBlockNode {
    return new ColumnsBlockNode(node.__cols.slice(), node.__key);
  }

  constructor(cols: string[] = [], key?: NodeKey) {
    super(key);
    this.__cols = cols;
  }

  $config() {
    return this.config("columnsBlock", { extends: DecoratorNode<JSX.Element> });
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const el = document.createElement("div");
    el.className = "editor-columns";
    el.dataset.count = String(this.__cols.length);
    return el;
  }

  updateDOM(prev: ColumnsBlockNode, dom: HTMLElement): boolean {
    if (prev.__cols.length !== this.__cols.length) dom.dataset.count = String(this.__cols.length);
    return false;
  }

  decorate(): JSX.Element {
    return (
      <ColumnsBlockInner
        cols={this.__cols.slice()}
        nodeKey={this.getKey()}
      />
    );
  }

  exportDOM(_editor: LexicalEditor): DOMExportOutput {
    const div = document.createElement("div");
    div.setAttribute("data-columns-block", "true");
    return { element: div };
  }

  exportJSON(): SerializedColumnsBlockNode {
    return {
      ...super.exportJSON(),
      type: "columnsBlock",
      count: this.__cols.length,
      cols: this.__cols.slice(),
      version: 1,
    };
  }

  static importJSON(serializedNode: SerializedColumnsBlockNode): ColumnsBlockNode {
    const cols = Array.isArray(serializedNode.cols)
      ? serializedNode.cols.slice()
      : new Array(Math.max(1, Math.floor(serializedNode.count) || 2)).fill(EMPTY_COL);
    return $createColumnsBlockNode(cols);
  }

  isInline(): false {
    return false;
  }
}

export function $createColumnsBlockNode(cols: string[] = []): ColumnsBlockNode {
  const c = cols.length > 0 ? cols.slice() : [EMPTY_COL, EMPTY_COL];
  return $applyNodeReplacement(new ColumnsBlockNode(c));
}

export function $isColumnsBlockNode(node: LexicalNode | null | undefined): node is ColumnsBlockNode {
  return node instanceof ColumnsBlockNode;
}

// Renders the column editors and, on each column change, persists the aggregated
// cols back onto the node inside an editor.update (so it commits to the page).
function ColumnsBlockInner({ cols, nodeKey }: { cols: string[]; nodeKey: string }) {
  const [editor] = useLexicalComposerContext();
  const pageId = useNotes((s) => s.currentId) ?? "";

  const handleChange = (next: string[]) => {
    editor.update(() => {
      const n = $getNodeByKey(nodeKey);
      if (n && $isColumnsBlockNode(n)) n.__cols = next.slice();
    });
  };

  return (
    <Suspense fallback={<div className="editor-columns editor-columns-loading">加载分栏…</div>}>
      <ColumnsBlockView cols={cols} pageId={pageId} onChange={handleChange} />
    </Suspense>
  );
}
