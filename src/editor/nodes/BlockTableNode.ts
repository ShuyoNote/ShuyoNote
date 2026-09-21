// 块级「表格」节点：**新 type**（`shuyo-table`）＋ **声明的** `blockId`。
//
// 只给**表格本身**身份（它是顶层块）；`TableRowNode` / `TableCellNode` 与**嵌套表格**都不给 ——
// 与"只有顶层块才有块身份"这条规则一致（理由见 `docs/plans/2026-09-18-crdt-block-id-ownership.md`）。
//
// ⚠️ `TableNode` 的状态比前面几个厚：`rowStriping` / `frozenColumnCount` / `frozenRowCount` / `colWidths`。
// 它们**是**有 getter 的（`getRowStriping` / `getFrozenColumns` / `getFrozenRows` / `getColWidths`），
// 但仍**不该手抄**：字段与 setter 的对应关系、以及"哪些字段要写回"是基类的事，
// 手抄一次就多一处会随 `@lexical/table` 升级而漂的代码。
// （2026-09-18 AMD 复核指出：我最初这里写"frozen 两个只有 setter"，与这一版实际不符，已改。）
// ⇒ 正确做法：拿基类的 `exportJSON()` 让**基类的 `updateFromJSON`** 自己吃一遍（见变换里的做法）。

import type { NodeKey } from "lexical";
import { TableNode, type SerializedTableNode } from "@lexical/table";

import { blockRevOf, withBlockRev } from "./blockIdHelpers";

/** 模型层的 type（落盘/同步前会被 `toLegacyDoc()` 还原成 `"table"`）。 */
export const BLOCK_TABLE_TYPE = "shuyo-table";

export interface SerializedBlockTableNode extends SerializedTableNode {
  blockId?: string;
  /** 块版本（Lamport）；**缺字段 = 老客户端产物**。 */
  blockRev?: number;
}

export class BlockTableNode extends TableNode {
  __blockId: string;
  __blockRev: number | null;

  static getType(): string {
    return BLOCK_TABLE_TYPE;
  }

  static clone(node: BlockTableNode): BlockTableNode {
    return new BlockTableNode(node.__blockId, node.__key, node.__blockRev);
  }

  static importJSON(serializedNode: Record<string, unknown>): BlockTableNode {
    const s = serializedNode as unknown as SerializedBlockTableNode;
    const node = $createBlockTableNode(s.blockId ?? "");
    // 基类自己的状态（rowStriping / frozen* / colWidths / format / indent / direction）交给它吃。
    node.updateFromJSON(s as never);
    // ⚠️ 放在 `updateFromJSON` **之后**：那是基类的方法，别指望它认识我们的声明字段。
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
    this.__blockId = (prevNode as BlockTableNode).__blockId;
    this.__blockRev = (prevNode as BlockTableNode).__blockRev;
  }

  exportJSON(): SerializedBlockTableNode {
    const json = super.exportJSON() as SerializedBlockTableNode;
    // 空 ID / 没有 rev 都不写字段（嵌套表格不给身份，别给落盘形态添噪音）。
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

export function $createBlockTableNode(blockId?: string, key?: NodeKey): BlockTableNode {
  return new BlockTableNode(blockId, key);
}

export function $isBlockTableNode(node: unknown): node is BlockTableNode {
  return node instanceof BlockTableNode;
}
