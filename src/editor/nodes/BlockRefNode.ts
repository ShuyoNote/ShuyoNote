import {
  $applyNodeReplacement,
  TextNode,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  type SerializedTextNode,
  type Spread,
} from "lexical";

export type SerializedBlockRefNode = Spread<
  {
    targetId: string;
  },
  SerializedTextNode
>;

// Inline node for a block reference `((blockId))`. Renders the target block's
// snippet as a styled inline link that jumps to (and previews) the source block.
export class BlockRefNode extends TextNode {
  __blockId: string;

  static getType(): string {
    return "blockref";
  }

  static clone(node: BlockRefNode): BlockRefNode {
    const clone = new BlockRefNode(node.__blockId, node.__text, node.__key);
    clone.__format = node.__format;
    clone.__style = node.__style;
    clone.__mode = node.__mode;
    clone.__detail = node.__detail;
    return clone;
  }

  constructor(blockId: string, text?: string, key?: NodeKey) {
    super(text ?? blockId, key);
    this.__blockId = blockId;
  }

  $config() {
    return this.config("blockref", { extends: TextNode });
  }

  createDOM(config: EditorConfig): HTMLElement {
    const dom = super.createDOM(config);
    dom.setAttribute("data-block-ref", this.__blockId);
    dom.classList.add("block-ref");
    return dom;
  }

  exportJSON(): SerializedBlockRefNode {
    return {
      ...super.exportJSON(),
      type: "blockref",
      targetId: this.__blockId,
      version: 1,
    };
  }

  static importJSON(serializedNode: SerializedBlockRefNode): BlockRefNode {
    const node = $createBlockRefNode(serializedNode.targetId, serializedNode.text);
    node.setFormat(serializedNode.format);
    node.setDetail(serializedNode.detail);
    node.setMode(serializedNode.mode);
    node.setStyle(serializedNode.style);
    return node;
  }
}

export function $createBlockRefNode(blockId: string, text?: string): BlockRefNode {
  return $applyNodeReplacement(new BlockRefNode(blockId, text));
}

export function $isBlockRefNode(node: LexicalNode | null | undefined): node is BlockRefNode {
  return node instanceof BlockRefNode;
}
