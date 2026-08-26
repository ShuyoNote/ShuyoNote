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
} from "lexical";

// One column inside a ColumnsNode. Each column is an element that holds the user's
// editable blocks (paragraphs); the parent's flex CSS lays columns side by side.

export type SerializedColumnNode = SerializedElementNode;

export class ColumnNode extends ElementNode {
  static getType(): string {
    return "column";
  }

  static clone(node: ColumnNode): ColumnNode {
    return new ColumnNode(node.__key);
  }

  constructor(key?: NodeKey) {
    super(key);
  }

  $config() {
    return this.config("column", { extends: ElementNode });
  }

  createDOM(config: EditorConfig): HTMLElement {
    const element = document.createElement("div");
    element.className = config.theme.column ?? "editor-column";
    return element;
  }

  updateDOM(): boolean {
    return false;
  }

  exportDOM(editor: LexicalEditor): DOMExportOutput {
    const { element } = super.exportDOM(editor);
    if (element instanceof HTMLElement) {
      element.setAttribute("data-column", "true");
    }
    return { element };
  }

  exportJSON(): SerializedColumnNode {
    return {
      ...super.exportJSON(),
      type: "column",
      version: 1,
    };
  }

  static importJSON(serializedNode: SerializedColumnNode): ColumnNode {
    const node = $createColumnNode();
    node.setFormat(serializedNode.format);
    node.setIndent(serializedNode.indent);
    node.setDirection(serializedNode.direction);
    return node;
  }

  // Pressing Enter at the end of the column's last block should stay inside the
  // column (add a sibling block there), not insert a paragraph after the ColumnsNode.
  insertNewAfter(_: RangeSelection, restoreSelection?: boolean): ParagraphNode {
    const newBlock = $createParagraphNode();
    this.append(newBlock);
    if (restoreSelection) newBlock.selectStart();
    return newBlock;
  }

  // Backspace at the very start of an EMPTY column collapses it into a paragraph
  // (so the empty column can be removed/closed), rather than breaking the layout.
  collapseAtStart(): boolean {
    const paragraph = $createParagraphNode();
    const children = this.getChildren();
    children.forEach((child) => paragraph.append(child));
    this.replace(paragraph);
    return true;
  }

  canMergeWhenEmpty(): boolean {
    return true;
  }

  isInline(): false {
    return false;
  }
}

export function $createColumnNode(): ColumnNode {
  return $applyNodeReplacement(new ColumnNode());
}

export function $isColumnNode(node: LexicalNode | null | undefined): node is ColumnNode {
  return node instanceof ColumnNode;
}
