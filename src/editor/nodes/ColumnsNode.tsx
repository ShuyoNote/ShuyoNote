import {
  $applyNodeReplacement,
  $createParagraphNode,
  ElementNode,
  ParagraphNode,
  type DOMExportOutput,
  type EditorConfig,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  type RangeSelection,
  type SerializedElementNode,
  type Spread,
} from "lexical";
import { $createColumnNode } from "./ColumnNode";

// Feishu-style 分栏 block: a top-level element whose children are N `ColumnNode`s
// laid out side by side (CSS flex). Each column holds its own paragraph(s), so each
// column is its own editable box. `__count === 0` means "columns not chosen yet" —
// the ColumnsPickerPlugin shows the 选择栏数 picker over the block until the user
// picks 2/3/4, which materializes that many columns.

export type SerializedColumnsNode = Spread<
  { count: number },
  SerializedElementNode
>;

export class ColumnsNode extends ElementNode {
  __count: number;

  static getType(): string {
    return "columns";
  }

  static clone(node: ColumnsNode): ColumnsNode {
    return new ColumnsNode(node.__count, node.__key);
  }

  constructor(count: number, key?: NodeKey) {
    super(key);
    this.__count = count;
  }

  $config() {
    return this.config("columns", { extends: ElementNode });
  }

  createDOM(config: EditorConfig): HTMLElement {
    const element = document.createElement("div");
    element.className = config.theme.columns ?? "editor-columns";
    element.dataset.count = String(this.__count);
    return element;
  }

  updateDOM(prev: ColumnsNode, dom: HTMLElement): boolean {
    if (prev.__count !== this.__count) {
      dom.dataset.count = String(this.__count);
      return true; // re-render so the attribute change is committed to the DOM
    }
    return false;
  }

  exportDOM(editor: LexicalEditor): DOMExportOutput {
    const { element } = super.exportDOM(editor);
    if (element instanceof HTMLElement) {
      element.setAttribute("data-columns", "true");
      element.setAttribute("data-count", String(this.__count));
    }
    return { element };
  }

  exportJSON(): SerializedColumnsNode {
    return {
      ...super.exportJSON(),
      type: "columns",
      count: this.__count,
      version: 1,
    };
  }

  static importJSON(serializedNode: SerializedColumnsNode): ColumnsNode {
    const node = $createColumnsNode(typeof serializedNode.count === "number" ? serializedNode.count : 0);
    node.setFormat(serializedNode.format);
    node.setIndent(serializedNode.indent);
    node.setDirection(serializedNode.direction);
    return node;
  }

  // Pressing Enter at the end of a column's last paragraph should not escape the
  // columns block; instead it should add a sibling paragraph inside the current
  // column (handled by Lexical). This override only kicks in on the ColumnsNode
  // itself (e.g. Enter at a truly empty columns block) → drop a paragraph after.
  insertNewAfter(_: RangeSelection, restoreSelection?: boolean): ParagraphNode {
    const newBlock = $createParagraphNode();
    this.insertAfter(newBlock, restoreSelection);
    return newBlock;
  }

  collapseAtStart(): boolean {
    const paragraph = $createParagraphNode();
    const children = this.getChildren();
    children.forEach((child) => paragraph.append(child));
    this.replace(paragraph);
    return true;
  }

  canMergeWhenEmpty(): boolean {
    return false;
  }

  isInline(): false {
    return false;
  }
}

export function $createColumnsNode(count = 0): ColumnsNode {
  const node = new ColumnsNode(count);
  // Always seed at least one column so the element is never empty (Lexical drops
  // empty element nodes). When a count>0 is requested (e.g. picked from the "+"
  // submenu), materialize exactly that many columns right away.
  const n = Math.max(1, Math.min(8, Math.floor(count) || 0));
  const cols = n > 0 ? n : 1;
  for (let i = 0; i < cols; i++) {
    const col = $createColumnNode();
    col.append($createParagraphNode());
    node.append(col);
  }
  return $applyNodeReplacement(node);
}

export function $isColumnsNode(node: LexicalNode | null | undefined): node is ColumnsNode {
  return node instanceof ColumnsNode;
}

// Rebuild the columns block into `count` columns (each with one empty paragraph).
// Mutates the block in place; the node instance is already writable inside an
// editor.update, so setting __count directly persists to the next editor state.
export function $setColumnsCount(node: ColumnsNode, count: number) {
  const n = Math.max(1, Math.min(8, Math.floor(count) || 1));
  node.clear();
  for (let i = 0; i < n; i++) {
    const col = $createColumnNode();
    col.append($createParagraphNode());
    node.append(col);
  }
  node.__count = n;
}
