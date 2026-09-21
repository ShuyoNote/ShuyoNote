// 块级「列表」节点：**新 type**（`shuyo-list`）＋ **声明的** `blockId`。
//
// 只做**列表本身**（它是顶层块）；`ListItemNode` 与嵌套列表**不给块身份** ——
// 与"只有顶层块才有块身份"这条规则一致（今天的 `serializeWithBlockIds` 与 Rust 侧
// `extract_block_ids` 都只看顶层）。理由与取舍见 `docs/plans/2026-09-18-crdt-block-id-ownership.md`。
//
// ⚠️ `ListNode` 的状态有三个：`__listType`（bullet/number/check）、`__tag`（ul/ol）、`__start`。
// 0.50 的克隆走 `afterCloneFrom`，所以这里除了 `static clone` 还补了 `afterCloneFrom`
// —— 声明字段在任何一条克隆路径上都不能丢（判据在 `BlockParagraphNode.test.ts` 里立过同款）。

import { ListNode, type ListType, type SerializedListNode } from "@lexical/list";
import type { NodeKey } from "lexical";

import { blockRevOf, withBlockRev } from "./blockIdHelpers";

/** 模型层的 type（落盘/同步前会被 `toLegacyDoc()` 还原成 `"list"`）。 */
export const BLOCK_LIST_TYPE = "shuyo-list";

export type LexicalListType = ListType;

export interface SerializedBlockListNode extends SerializedListNode {
  blockId?: string;
  /** 块版本（Lamport）；**缺字段 = 老客户端产物**。 */
  blockRev?: number;
}

export class BlockListNode extends ListNode {
  __blockId: string;
  __blockRev: number | null;

  static getType(): string {
    return BLOCK_LIST_TYPE;
  }

  static clone(node: BlockListNode): BlockListNode {
    return new BlockListNode(node.__listType, node.__start, node.__blockId, node.__key, node.__blockRev);
  }

  static importJSON(serializedNode: Record<string, unknown>): BlockListNode {
    const s = serializedNode as unknown as SerializedBlockListNode;
    const node = $createBlockListNode(
      (s.listType ?? "number") as LexicalListType,
      typeof s.start === "number" ? s.start : 1,
      s.blockId ?? "",
    );
    node.setFormat(s.format);
    node.setIndent(s.indent);
    node.setDirection(s.direction);
    node.setBlockRev(blockRevOf(s));
    return node;
  }

  constructor(
    listType: LexicalListType = "number",
    start = 1,
    blockId?: string,
    key?: NodeKey,
    blockRev: number | null = null,
  ) {
    super(listType, start, key);
    this.__blockId = blockId ?? "";
    this.__blockRev = blockRev;
  }

  /** 0.50 的克隆路径（基类也走它）。声明字段必须跟着走，否则改个缩进就会把块 ID 清空。 */
  afterCloneFrom(prevNode: this): void {
    super.afterCloneFrom(prevNode);
    this.__blockId = (prevNode as BlockListNode).__blockId;
    this.__blockRev = (prevNode as BlockListNode).__blockRev;
  }

  exportJSON(): SerializedBlockListNode {
    const json = super.exportJSON() as SerializedBlockListNode;
    // 空 ID / 没有 rev 都不写字段（嵌套列表不给身份，别给落盘形态添噪音）。
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

export function $createBlockListNode(
  listType: LexicalListType = "number",
  start = 1,
  blockId?: string,
  key?: NodeKey,
): BlockListNode {
  return new BlockListNode(listType, start, blockId, key);
}

export function $isBlockListNode(node: unknown): node is BlockListNode {
  return node instanceof BlockListNode;
}
