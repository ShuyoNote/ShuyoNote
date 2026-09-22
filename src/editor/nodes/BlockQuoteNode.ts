// 块级「引用」节点：**新 type**（`shuyo-quote`）＋ **声明的** `blockId`。
//
// 与段落/标题同一套路（背景见 `docs/plans/2026-09-18-crdt-block-id-ownership.md`）。
// `QuoteNode` 自己没有额外状态（不像标题有 tag），所以这个类是最薄的一层：
// 只多一个声明字段 + 三处（import/export/clone）把它带上。
//
// ⚠️ 同样的两条纪律：**本类只活在编辑器里**（写出去先过 `toLegacyDoc()`）；
// `insertNewAfter` 里的内建工厂要换成模型工厂（引用里回车会新起一个段落）。

import type { NodeKey, SerializedElementNode } from "lexical";
import { QuoteNode } from "@lexical/rich-text";

import { newBlockId } from "../../lib/blockIdentity";
import { blockRevOf, withBlockRev } from "./blockIdHelpers";
import { $createBlockParagraphNode } from "./BlockParagraphNode";

/** 模型层的 type（落盘/同步前会被 `toLegacyDoc()` 还原成 `"quote"`）。 */
export const BLOCK_QUOTE_TYPE = "shuyo-quote";

export interface SerializedBlockQuoteNode extends SerializedElementNode {
  blockId?: string;
  /** 块版本（Lamport）；**缺字段 = 老客户端产物**。 */
  blockRev?: number;
}

export class BlockQuoteNode extends QuoteNode {
  __blockId: string;
  __blockRev: number | null;

  static getType(): string {
    return BLOCK_QUOTE_TYPE;
  }

  static clone(node: BlockQuoteNode): BlockQuoteNode {
    return new BlockQuoteNode(node.__blockId, node.__key, node.__blockRev);
  }

  static importJSON(serializedNode: Record<string, unknown>): BlockQuoteNode {
    const s = serializedNode as unknown as SerializedBlockQuoteNode;
    const node = $createBlockQuoteNode(s.blockId ?? "");
    node.setFormat(s.format);
    node.setIndent(s.indent);
    node.setDirection(s.direction);
    node.setBlockRev(blockRevOf(s));
    return node;
  }

  constructor(blockId?: string, key?: NodeKey, blockRev: number | null = null) {
    super(key);
    this.__blockId = blockId ?? "";
    this.__blockRev = blockRev;
  }

  exportJSON(): SerializedBlockQuoteNode {
    const json = super.exportJSON() as SerializedBlockQuoteNode;
    // 空 ID / 没有 rev 都不写字段（嵌套块不给身份，别给落盘形态添噪音）—— 与段落/标题一致。
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

  /**
   * 引用里回车：基类会新起一个**段落**，这里换成模型段落（并当场铸 ID —— 新建块的身份不能等保存）。
   */
  insertNewAfter(selection: Parameters<QuoteNode["insertNewAfter"]>[0], restoreSelection = true) {
    const newBlock = $createBlockParagraphNode(newBlockId());
    newBlock.setDirection(this.getDirection());
    this.insertAfter(newBlock, restoreSelection);
    void selection;
    return newBlock;
  }
}

export function $createBlockQuoteNode(blockId?: string, key?: NodeKey): BlockQuoteNode {
  return new BlockQuoteNode(blockId, key);
}

export function $isBlockQuoteNode(node: unknown): node is BlockQuoteNode {
  return node instanceof BlockQuoteNode;
}
