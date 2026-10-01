// 表格单元格里的**行内格式**往返判据（AMD 侧补，2026-10-01）。
//
// 为什么单独一条（补的是 owner 实测出来的空档）：
// owner 反馈「表格内的加粗问题没有解决」——`| **合规是刚需** | … |` 导进来后是**字面文本** ✗。
// 根因不是"解析器不认识粗体"，而是**整行表格被 `TABLE` 这个 element transformer 吃掉**：
// 行级的文本格式 transformer（`TEXT_FORMAT_TRANSFORMERS`）**根本看不到单元格里的字** ✗
// （`markdownTransformers.ts` 的 TABLE handleImportAfterStartMatch 原先直接
//  `$createTextNode(原文)`）。改成走 `parseInline` 生成带 format 的节点 ✓。
//
// 判据形态：**三条同时成立** ——
//   ① `**粗**` 变成一个 `hasFormat("bold")` 的节点 ✓
//   ② 该节点文本**不含 `**`**（标记被吃掉、不是留着字面 ✓）
//   ③ `` `码` `` 与 `*斜*` 同样各自成立 ✓
// ⚠️ **反例（必须能红）**：把 `createMarkdownCell` 换回 `$createTextNode(text)` ⇒ 本判据立刻红 ✓。
import { $convertFromMarkdownString } from "@lexical/markdown";
import {
  $isTableCellNode,
  TableCellHeaderStates,
  TableCellNode,
  TableNode,
  TableRowNode,
} from "@lexical/table";
import {
  $getRoot,
  $isElementNode,
  $isTextNode,
  createEditor,
  type LexicalNode,
} from "lexical";
import { describe, expect, it } from "vitest";

import { BlockTableNode } from "./nodes/BlockTableNode";
import { SHUYONOTE_TRANSFORMERS } from "./markdownTransformers";

const MD = [
  "| 优势 | 说明 |",
  "| --- | --- |",
  "| **合规是刚需** | 有 `代码` 与 *斜体* |",
].join("\n");

interface Leaf {
  text: string;
  bold: boolean;
  italic: boolean;
  code: boolean;
}

/** 在真编辑器里转换一次，把表格所有单元格的叶子文本节点摊平出来。 */
function convertLeaves(md: string): Leaf[] {
  const editor = createEditor({
    namespace: "amd-md-table-inline",
    nodes: [BlockTableNode, TableNode, TableRowNode, TableCellNode],
    onError: (e) => {
      throw e;
    },
  });
  let out: Leaf[] = [];
  editor.update(
    () => {
      $convertFromMarkdownString(md, SHUYONOTE_TRANSFORMERS, $getRoot());
      const table = $getRoot().getFirstChild();
      const leaves: Leaf[] = [];
      const walk = (node: LexicalNode | null): void => {
        if (node === null) return;
        if ($isTextNode(node)) {
          leaves.push({
            text: node.getTextContent(),
            bold: node.hasFormat("bold"),
            italic: node.hasFormat("italic"),
            code: node.hasFormat("code"),
          });
          return;
        }
        if ($isElementNode(node)) {
          for (const child of node.getChildren()) walk(child);
        }
      };
      walk(table);
      out = leaves;
    },
    { discrete: true },
  );
  return out;
}

describe("表格单元格的行内格式", () => {
  it("`**粗**` 解析成 bold 节点，且不留字面 `**`", () => {
    const leaves = convertLeaves(MD);
    const bold = leaves.filter((l) => l.bold);
    expect(bold.length).toBeGreaterThan(0);
    expect(bold.some((l) => l.text.includes("合规是刚需"))).toBe(true);
    // ② 标记必须被吃掉：任何一个叶子都不该还带着 `**`
    expect(leaves.every((l) => !l.text.includes("**"))).toBe(true);
  });

  it("`` `码` `` 与 `*斜*` 同样各自成立", () => {
    const leaves = convertLeaves(MD);
    expect(leaves.some((l) => l.code && l.text.includes("代码"))).toBe(true);
    expect(leaves.some((l) => l.italic && l.text.includes("斜体"))).toBe(true);
    // 反例守卫：反引号与星号都不该以字面形态留下
    expect(leaves.every((l) => !l.text.includes("`") && !l.text.includes("*"))).toBe(true);
  });

  it("表头**不靠** headerState —— 观感由 CSS 负责（2026-10-01 撤回了 ROW）", () => {
    // 来由：曾把表头行标成 TableCellHeaderStates.ROW（渲染真 <th>），随后 owner 侧报
    // 「tableObserver not found for tableKey」✗；那笔不是观感的来源（加粗/背景由 App.css 的
    // `.editor-content table th` / `tr:first-child > td` 给）⇒ 撤回。
    // 本判据钉住"别再偷偷把它加回来"：所有单元格都应是 NO_STATUS ✓。
    const editor = createEditor({
      namespace: "amd-md-table-header",
      nodes: [BlockTableNode, TableNode, TableRowNode, TableCellNode],
      onError: (e) => {
        throw e;
      },
    });
    let states: number[] = [];
    editor.update(
      () => {
        $convertFromMarkdownString(MD, SHUYONOTE_TRANSFORMERS, $getRoot());
        const table = $getRoot().getFirstChild();
        const rows = $isElementNode(table) ? table.getChildren() : [];
        const first = rows[0];
        states = $isElementNode(first)
          ? first
              .getChildren()
              .map((c) => ($isTableCellNode(c) ? c.getHeaderStyles() : -1))
          : [];
      },
      { discrete: true },
    );
    expect(states.length).toBe(2);
    expect(states.every((s) => s === TableCellHeaderStates.NO_STATUS)).toBe(true);
  });
});
