import {
  TextNode,
  $applyNodeReplacement,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  type SerializedTextNode,
  type Spread,
} from "lexical";

export type SerializedPdfRefNode = Spread<
  {
    attachmentId: string;
    pageIndex: number;
  },
  SerializedTextNode
>;

// Inline node for a `pdf://attachment#page` reference (the "批注即块" back-link).
// Renders as a styled, clickable link; `PdfRefPlugin` handles the click (re-open
// the PDF reader at that page). Mirrors BlockRefNode.
export class PdfRefNode extends TextNode {
  __attachmentId: string;
  __pageIndex: number;

  static getType(): string {
    return "pdfref";
  }

  static clone(node: PdfRefNode): PdfRefNode {
    const clone = new PdfRefNode(node.__attachmentId, node.__pageIndex, node.__text, node.__key);
    clone.__format = node.__format;
    clone.__style = node.__style;
    clone.__mode = node.__mode;
    clone.__detail = node.__detail;
    return clone;
  }

  constructor(attachmentId: string, pageIndex: number, text?: string, key?: NodeKey) {
    super(text ?? `pdf://${attachmentId}#${pageIndex}`, key);
    this.__attachmentId = attachmentId;
    this.__pageIndex = pageIndex;
  }

  $config() {
    return this.config("pdfref", { extends: TextNode });
  }

  createDOM(config: EditorConfig): HTMLElement {
    const dom = super.createDOM(config);
    dom.setAttribute("data-pdf-ref", `${this.__attachmentId}:${this.__pageIndex}`);
    dom.classList.add("pdf-ref");
    return dom;
  }

  exportJSON(): SerializedPdfRefNode {
    return {
      ...super.exportJSON(),
      type: "pdfref",
      attachmentId: this.__attachmentId,
      pageIndex: this.__pageIndex,
      version: 1,
    };
  }

  static importJSON(serializedNode: SerializedPdfRefNode): PdfRefNode {
    const node = $createPdfRefNode(serializedNode.attachmentId, serializedNode.pageIndex, serializedNode.text);
    node.setFormat(serializedNode.format);
    node.setDetail(serializedNode.detail);
    node.setMode(serializedNode.mode);
    node.setStyle(serializedNode.style);
    return node;
  }
}

export function $createPdfRefNode(attachmentId: string, pageIndex: number, text?: string): PdfRefNode {
  return $applyNodeReplacement(new PdfRefNode(attachmentId, pageIndex, text));
}

export function $isPdfRefNode(node: LexicalNode | null | undefined): node is PdfRefNode {
  return node instanceof PdfRefNode;
}
