import {
  $applyNodeReplacement,
  ElementNode,
  type NodeKey,
  type ParagraphNode,
  type DOMExportOutput,
  type EditorConfig,
  type LexicalEditor,
  type LexicalNode,
  type RangeSelection,
  type SerializedElementNode,
} from "lexical";

import { newBlockId } from "../../lib/blockIdentity";
import { $createBlockParagraphNode } from "./BlockParagraphNode";

export type SerializedCalloutNode = SerializedElementNode & { blockId?: string };

export class CalloutNode extends ElementNode {
  __blockId: string;

  $config() {
    return this.config("callout", { extends: ElementNode });
  }

  static getType(): string {
    return "callout";
  }

  static clone(node: CalloutNode): CalloutNode {
    return new CalloutNode(node.__blockId, node.__key);
  }

  constructor(blockId?: string, key?: NodeKey) {
    super(key);
    this.__blockId = blockId ?? "";
  }

  afterCloneFrom(prevNode: this): void {
    super.afterCloneFrom(prevNode);
    this.__blockId = (prevNode as CalloutNode).__blockId;
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
    const json: SerializedCalloutNode = {
      ...super.exportJSON(),
      type: "callout",
      version: 1,
    };
    // 空 ID 不写字段：**嵌套** callout 不给身份（只有顶层块有），别给落盘形态添噪音。
    return this.__blockId ? { ...json, blockId: this.__blockId } : json;
  }

  static importJSON(serializedNode: SerializedCalloutNode): CalloutNode {
    const node = $createCalloutNode(serializedNode.blockId ?? "");
    node.setFormat(serializedNode.format);
    node.setIndent(serializedNode.indent);
    node.setDirection(serializedNode.direction);
    return node;
  }

  /** 块身份（与包出来的 `Block*Node` 同类 API）。 */
  getBlockId(): string {
    return this.__blockId;
  }

  setBlockId(blockId: string): void {
    const writable = this.getWritable();
    writable.__blockId = blockId;
  }

  insertNewAfter(_: RangeSelection, restoreSelection?: boolean): ParagraphNode {
    // 跳出 callout 的新段落必须是**模型段落**并当场带 ID（否则它的身份只能等保存时注入）。
    const newBlock = $createBlockParagraphNode(newBlockId());
    this.insertAfter(newBlock, restoreSelection);
    return newBlock;
  }

  collapseAtStart(): boolean {
    const paragraph = $createBlockParagraphNode(newBlockId());
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

export function $createCalloutNode(blockId?: string): CalloutNode {
  return $applyNodeReplacement(new CalloutNode(blockId));
}

export function $isCalloutNode(node: LexicalNode | null | undefined): node is CalloutNode {
  return node instanceof CalloutNode;
}
