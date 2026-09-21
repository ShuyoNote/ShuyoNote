// 块级「水平线」节点：**新 type**（`shuyo-horizontalrule`）＋ **声明的** `blockId`。
//
// 与引用一样是最薄的一层（`HorizontalRuleNode` 没有额外状态）。
// ⚠️ 纪律同前：**本类只活在编辑器里**，写出去先过 `toLegacyDoc()`（还原成 `horizontalrule`）。

import type { NodeKey, SerializedElementNode } from "lexical";
import { HorizontalRuleNode } from "@lexical/react/LexicalHorizontalRuleNode";

import { blockRevOf, withBlockRev } from "./blockIdHelpers";

/** 模型层的 type（落盘/同步前会被 `toLegacyDoc()` 还原成 `"horizontalrule"`）。 */
export const BLOCK_HORIZONTAL_RULE_TYPE = "shuyo-horizontalrule";

export interface SerializedBlockHorizontalRuleNode extends SerializedElementNode {
  blockId?: string;
  /** 块版本（Lamport）；**缺字段 = 老客户端产物**。 */
  blockRev?: number;
}

export class BlockHorizontalRuleNode extends HorizontalRuleNode {
  __blockId: string;
  __blockRev: number | null;

  static getType(): string {
    return BLOCK_HORIZONTAL_RULE_TYPE;
  }

  static clone(node: BlockHorizontalRuleNode): BlockHorizontalRuleNode {
    return new BlockHorizontalRuleNode(node.__blockId, node.__key, node.__blockRev);
  }

  static importJSON(serializedNode: Record<string, unknown>): BlockHorizontalRuleNode {
    const s = serializedNode as unknown as SerializedBlockHorizontalRuleNode;
    // ⚠️ `HorizontalRuleNode` 是 **DecoratorNode**（不是 ElementNode）⇒ **没有**
    // `setFormat`/`setIndent`/`setDirection` 这些方法，别照抄段落那套（tsc 会直接报 TS2339）。
    const node = $createBlockHorizontalRuleNode(s.blockId ?? "");
    node.setBlockRev(blockRevOf(s));
    return node;
  }

  constructor(blockId?: string, key?: NodeKey, blockRev: number | null = null) {
    super(key);
    this.__blockId = blockId ?? "";
    this.__blockRev = blockRev;
  }

  afterCloneFrom(prevNode: this): void {
    super.afterCloneFrom(prevNode);
    this.__blockId = (prevNode as BlockHorizontalRuleNode).__blockId;
    this.__blockRev = (prevNode as BlockHorizontalRuleNode).__blockRev;
  }

  exportJSON(): SerializedBlockHorizontalRuleNode {
    const json = super.exportJSON() as SerializedBlockHorizontalRuleNode;
    return withBlockRev(this.__blockId ? { ...json, blockId: this.__blockId } : json, this.__blockRev);
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
}

export function $createBlockHorizontalRuleNode(blockId?: string, key?: NodeKey): BlockHorizontalRuleNode {
  return new BlockHorizontalRuleNode(blockId, key);
}

export function $isBlockHorizontalRuleNode(node: unknown): node is BlockHorizontalRuleNode {
  return node instanceof BlockHorizontalRuleNode;
}
