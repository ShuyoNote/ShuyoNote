// 表格节点的**基类状态**往返判据（AMD 侧补，2026-09-18）。
//
// 为什么单独一条（不是洁癖，是补一个实测出来的空档）：
// `BlockTableNode.importJSON` 的全部意义就是"让基类的 `updateFromJSON(serialized)` 自己吃一遍"
// ——`TableNode` 的状态比前几个类型厚（`rowStriping` / `frozenColumnCount` / `frozenRowCount` /
// `colWidths`），**手抄必丢**。但这条承诺原先**没有任何判据守着**：把那行
// `node.updateFromJSON(s as never);` 删掉之后，块身份那份判据 37 条与**全量 1116 条仍然全绿**
// （AMD 在 `14b7c3e4` 上实测），失败面是"打开已保存页面时冻结行列 / 列宽 / 斑马纹静默丢失"。
//
// 判据形态：**导出 → 用同一份 JSON 反向构造 → 再导出，两次必须逐字段相等**。
// 这样它同时钉住两件事：① 基类状态确实序列化出来了（前提断言，防"判据本身是空的"）；
// ② `importJSON` 把它们原样吃回去（删掉 `updateFromJSON` 立刻红）。
//
// ⚠️ 只测**节点层**的往返，不碰编辑器/变换（那是 `blockIdTransform.test.ts` 的事）——
// 两层互不依赖，谁坏谁红。
import { TableCellNode, TableRowNode } from "@lexical/table";
import { createEditor } from "lexical";
import { describe, expect, it } from "vitest";

import { $createBlockTableNode, BlockTableNode } from "./BlockTableNode";

/** 在真编辑器里跑一段节点操作（`$create*` 必须在 update 内）。 */
function inEditor<T>(fn: () => T): T {
  const editor = createEditor({
    namespace: "amd-block-table-state",
    nodes: [BlockTableNode, TableRowNode, TableCellNode],
    onError: (e) => {
      throw e;
    },
  });
  let out!: T;
  editor.update(
    () => {
      out = fn();
    },
    { discrete: true },
  );
  return out;
}

describe("BlockTableNode：基类状态过 importJSON 往返不丢", () => {
  it("★ 导出 → 反向构造 → 再导出，两份 JSON 必须相等（删掉 updateFromJSON 就红）", () => {
    const before = inEditor(() => {
      const table = $createBlockTableNode("bid-1");
      table.setRowStriping(true);
      table.setFrozenColumns(2);
      table.setFrozenRows(1);
      table.setColWidths([120, 80]);
      return table.exportJSON();
    });

    // 前提：基类确实把这些状态序列化出来了（否则这条判据是空的）
    expect(before.rowStriping).toBe(true);
    expect(before.frozenColumnCount).toBe(2);
    expect(before.frozenRowCount).toBe(1);
    expect(before.colWidths).toEqual([120, 80]);

    const after = inEditor(() => BlockTableNode.importJSON(before as never).exportJSON());

    expect(after).toEqual(before);
  });

  it("往返之后仍能按 getter 读回（不是只有 JSON 长得像）", () => {
    const before = inEditor(() => {
      const table = $createBlockTableNode("bid-2");
      table.setRowStriping(false);
      table.setFrozenColumns(3);
      table.setFrozenRows(2);
      table.setColWidths([64]);
      return table.exportJSON();
    });
    // ⚠️ getter 必须在 update 内读（它们走 `getLatest()`，需要活动的编辑器状态）
    const read = inEditor(() => {
      const restored = BlockTableNode.importJSON(before as never);
      return {
        rowStriping: restored.getRowStriping(),
        frozenColumns: restored.getFrozenColumns(),
        frozenRows: restored.getFrozenRows(),
        colWidths: restored.getColWidths(),
      };
    });
    expect(read).toEqual({ rowStriping: false, frozenColumns: 3, frozenRows: 2, colWidths: [64] });
  });

  it("块身份也一起回来（这条与基类状态无关，防我把两件事混着测）", () => {
    const before = inEditor(() => $createBlockTableNode("bid-3").exportJSON());
    const restored = inEditor(() => BlockTableNode.importJSON(before as never));
    expect(restored.getBlockId()).toBe("bid-3");
  });
});
