// 块级「表格」节点：**新 type**（`shuyo-table`）＋ **声明的** `blockId`。
//
// 只给**表格本身**身份（它是顶层块）；`TableRowNode` / `TableCellNode` 与**嵌套表格**都不给 ——
// 与"只有顶层块才有块身份"这条规则一致（理由见 `docs/plans/2026-09-18-crdt-block-id-ownership.md`）。
//
// ⚠️ `TableNode` 的状态比前面几个厚：`rowStriping` / `frozenColumnCount` / `frozenRowCount` / `colWidths`。
// 它们**不是**都能用 getter 读出来（只有 `getRowStriping()` / `getColWidths()`），
// 所以迁移时**不要手抄**每个字段 —— 让基类的 `updateFromJSON(serialized)` 自己吃一遍（见变换里的做法）。

import type { NodeKey } from "lexical";
import { TableNode, type SerializedTableNode } from "@lexical/table";

/** 模型层的 type（落盘/同步前会被 `toLegacyDoc()` 还原成 `"table"`）。 */
export const BLOCK_TABLE_TYPE = "shuyo-table";

export interface SerializedBlockTableNode extends SerializedTableNode {
  blockId?: string;
}

export class BlockTableNode extends TableNode {
  __blockId: string;

  static getType(): string {
    return BLOCK_TABLE_TYPE;
  }

  static clone(node: BlockTableNode): BlockTableNode {
    return new BlockTableNode(node.__blockId, node.__key);
  }

  static importJSON(serializedNode: Record<string, unknown>): BlockTableNode {
    const s = serializedNode as unknown as SerializedBlockTableNode;
    const node = $createBlockTableNode(s.blockId ?? "");
    // 基类自己的状态（rowStriping / frozen* / colWidths / format / indent / direction）交给它吃。
    node.updateFromJSON(s as never);
    return node;
  }

  constructor(blockId?: string, key?: NodeKey) {
    super(key);
    this.__blockId = blockId ?? "";
  }

  afterCloneFrom(prevNode: this): void {
    super.afterCloneFrom(prevNode);
    this.__blockId = (prevNode as BlockTableNode).__blockId;
  }

  exportJSON(): SerializedBlockTableNode {
    const json = super.exportJSON() as SerializedBlockTableNode;
    // 空 ID 不写字段（嵌套表格不给身份，别给落盘形态添噪音）。
    return this.__blockId ? { ...json, blockId: this.__blockId } : json;
  }

  getBlockId(): string {
    return this.__blockId;
  }

  setBlockId(blockId: string): void {
    const writable = this.getWritable();
    writable.__blockId = blockId;
  }
}

export function $createBlockTableNode(blockId?: string, key?: NodeKey): BlockTableNode {
  return new BlockTableNode(blockId, key);
}

export function $isBlockTableNode(node: unknown): node is BlockTableNode {
  return node instanceof BlockTableNode;
}
