// 块级「标题」节点：**新 type**（`shuyo-heading`）＋ **声明的** `blockId`。
//
// 与 `BlockParagraphNode` 同一套路（背景与取舍见 `docs/plans/2026-09-18-crdt-block-id-ownership.md`）：
// 块 ID 必须成为**节点模型的一部分**，`@lexical/yjs` 才会同步它；而"同 type 子类化内建节点"在
// Lexical 0.50 会抛错（实测），所以只能**新 type**＋加载时映射（`blockIdentity.toModelDoc`）。
//
// ⚠️ 两条纪律：
//   1. **本类只活在编辑器里**：写出去（落盘/同步 wire/导出）之前一律 `toLegacyDoc()` 还原成 `heading`；
//   2. `insertNewAfter` 里那三处内建工厂（`$createParagraphNode` / `$createHeadingNode`）**必须换成
//      模型工厂** —— 否则回车/拆分会把块又变回老类型，块 ID 只能在保存时注入（同一类洞，判据抓过一次）。

import type { NodeKey } from "lexical";
import {
  HeadingNode,
  type HeadingTagType,
  type SerializedHeadingNode,
} from "@lexical/rich-text";

import { newBlockId } from "../../lib/blockIdentity";
import { $createBlockParagraphNode } from "./BlockParagraphNode";

/** 模型层的 type（落盘/同步前会被 `toLegacyDoc()` 还原成 `"heading"`）。 */
export const BLOCK_HEADING_TYPE = "shuyo-heading";

export interface SerializedBlockHeadingNode extends SerializedHeadingNode {
  blockId?: string;
}

export class BlockHeadingNode extends HeadingNode {
  __blockId: string;

  static getType(): string {
    return BLOCK_HEADING_TYPE;
  }

  static clone(node: BlockHeadingNode): BlockHeadingNode {
    return new BlockHeadingNode(node.__tag, node.__blockId, node.__key);
  }

  static importJSON(serializedNode: Record<string, unknown>): BlockHeadingNode {
    const s = serializedNode as unknown as SerializedBlockHeadingNode;
    const node = $createBlockHeadingNode((s.tag ?? "h1") as HeadingTagType, s.blockId ?? "");
    node.setFormat(s.format);
    node.setIndent(s.indent);
    node.setDirection(s.direction);
    return node;
  }

  constructor(tag: HeadingTagType = "h1", blockId?: string, key?: NodeKey) {
    super(tag, key);
    this.__blockId = blockId ?? "";
  }

  exportJSON(): SerializedBlockHeadingNode {
    return { ...(super.exportJSON() as SerializedHeadingNode), blockId: this.__blockId };
  }

  getBlockId(): string {
    return this.__blockId;
  }

  setBlockId(blockId: string): void {
    const writable = this.getWritable();
    writable.__blockId = blockId;
  }

  /**
   * 回车 / 拆分。**逐支复刻基类行为**，只把三处内建工厂换成模型工厂：
   * · 在末尾（或没有选区）⇒ 新起一个**段落**；
   * · 在中间拆分 ⇒ 新起一个**同 tag 的标题**（保留对齐与样式）；
   * · 在开头回车 ⇒ 把**本标题**降级成段落（`replace(..., true)` 带子节点）。
   */
  insertNewAfter(selection: Parameters<HeadingNode["insertNewAfter"]>[0], restoreSelection = true) {
    const anchorOffset = selection ? selection.anchor.offset : 0;
    const lastDesc = this.getLastDescendant();
    const isAtEnd =
      !lastDesc ||
      (selection && selection.anchor.key === lastDesc.getKey() && anchorOffset === lastDesc.getTextContentSize());

    const newElement =
      isAtEnd || !selection
        ? $createBlockParagraphNode(newBlockId())
        : $createBlockHeadingNode(this.getTag(), newBlockId()).setFormat(this.getFormatType()).setStyle(this.getStyle());
    newElement.setDirection(this.getDirection());
    this.insertAfter(newElement, restoreSelection);

    if (anchorOffset === 0 && !this.isEmpty() && selection) {
      const paragraph = $createBlockParagraphNode(newBlockId());
      paragraph.select();
      this.replace(paragraph, true);
    }
    return newElement;
  }
}

/** 工厂。**所有**新建标题都应经它（别用内建的 `$createHeadingNode`，那会产出老 type）。 */
export function $createBlockHeadingNode(tag: HeadingTagType = "h1", blockId?: string, key?: NodeKey): BlockHeadingNode {
  return new BlockHeadingNode(tag, blockId, key);
}

export function $isBlockHeadingNode(node: unknown): node is BlockHeadingNode {
  return node instanceof BlockHeadingNode;
}
