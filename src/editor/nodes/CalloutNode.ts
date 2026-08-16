import {
  $applyNodeReplacement,
  $createParagraphNode,
  ElementNode,
  ParagraphNode,
  type DOMExportOutput,
  type EditorConfig,
  type LexicalEditor,
  type LexicalNode,
  type RangeSelection,
  type SerializedElementNode,
} from "lexical";

export type SerializedCalloutNode = SerializedElementNode;

export class CalloutNode extends ElementNode {
  $config() {
    return this.config("callout", { extends: ElementNode });
  }

  static getType(): string {
    return "callout";
  }

  static clone(node: CalloutNode): CalloutNode {
    return new CalloutNode(node.__key);
  }

  createDOM(config: EditorConfig): HTMLElement {
    const element = document.createElement("div");
    element.className = config.theme.callout ?? "editor-callout";
    return element;
  }

  updateDOM(): boolean {
    return false;
  }

  exportDOM(editor: LexicalEditor): DOMExportOutput {
    const { element } = super.exportDOM(editor);
    if (element instanceof HTMLElement) {
      element.setAttribute("data-callout", "true");
    }
    return { element };
  }

  exportJSON(): SerializedCalloutNode {
    return {
      ...super.exportJSON(),
      type: "callout",
      version: 1,
    };
  }

  static importJSON(serializedNode: SerializedCalloutNode): CalloutNode {
    const node = $createCalloutNode();
    node.setFormat(serializedNode.format);
    node.setIndent(serializedNode.indent);
    node.setDirection(serializedNode.direction);
    return node;
  }

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
    return true;
  }

  isInline(): false {
    return false;
  }
}

export function $createCalloutNode(): CalloutNode {
  return $applyNodeReplacement(new CalloutNode());
}

export function $isCalloutNode(node: LexicalNode | null | undefined): node is CalloutNode {
  return node instanceof CalloutNode;
}
