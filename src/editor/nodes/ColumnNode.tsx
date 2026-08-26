import {
  $applyNodeReplacement,
  ElementNode,
  type DOMExportOutput,
  type EditorConfig,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
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
