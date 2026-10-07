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
import { $convertFromMarkdownString, $convertToMarkdownString } from "@lexical/markdown";
import {
  $isTableCellNode,
  TableCellHeaderStates,
  TableCellNode,
  TableNode,
  TableRowNode,
} from "@lexical/table";
import { CodeHighlightNode } from "@lexical/code";
import {
  $getRoot,
  $isElementNode,
  $isTextNode,
  createEditor,
  type LexicalNode,
} from "lexical";
import { describe, expect, it } from "vitest";

import { BlockTableNode } from "./nodes/BlockTableNode";
import { MermaidNode } from "./nodes/MermaidNode";
import { SafeCodeNode } from "./nodes/SafeCodeNode";
import { SHUYONOTE_TRANSFORMERS, preprocessMarkdownImport } from "./markdownTransformers";

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

// ```mermaid 围栏 —— 2026-10-05 补。
// 来由（owner 实测）：导入的 .md 里 10 张流程图**全变成代码块**，编辑器只显示源码 ⇒
// 「页面识别不了图形」。根因是 `SHUYONOTE_TRANSFORMERS` 里只有 Lexical 的 `CODE`（它把语言
// 抄成 `mermaid` 但产出代码块），**没有任何 transformer 造 `MermaidNode`** ⇒ 那个节点事实上是死的。
describe("```mermaid 围栏 ⇒ mermaid 块（2026-10-05）", () => {
  // ⚠️ 节点集**照应用的 `EDITOR_NODES`**（代码块是 `SafeCodeNode`，没有内建 `CodeNode`）——
  //    少一个都会在别的分支上炸，测出来的就不是应用的行为。
  const nodes = [
    MermaidNode,
    SafeCodeNode,
    CodeHighlightNode,
    BlockTableNode,
    TableNode,
    TableRowNode,
    TableCellNode,
  ];

  function convert(md: string): Array<Record<string, unknown>> {
    const editor = createEditor({
      namespace: "mermaid-import",
      nodes,
      onError: (e) => {
        throw e;
      },
    });
    editor.update(
      () => {
        $convertFromMarkdownString(md, SHUYONOTE_TRANSFORMERS, $getRoot());
      },
      { discrete: true },
    );
    // ⚠️ `$getRoot().toJSON()` 在 Lexical 0.50 不存在 —— 要读编辑器状态（RootNode 不序列化）。
    return (editor.getEditorState().toJSON() as { root: { children: Array<Record<string, unknown>> } })
      .root.children;
  }

  /**
   * 把导入结果的 JSON 摊平成 `{type, 该节点自己的字段}` 清单。
   * ⚠️ **不能只看 `kids[0].type`**：应用装饰节点（mermaid / formula / drawing）直接挂到**根**上时，
   *    Lexical 的根规范化会把它裹进一个段落（`blockIdTransform.test.ts` 里那条注释记过同一个现象）
   *    ⇒ 断言要"在整棵树里找"，否则测的是包裹形状、不是判据 ✓。
   */
  function flatten(node: unknown, out: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
    if (!node || typeof node !== "object") return out;
    const rec = node as Record<string, unknown>;
    if (typeof rec.type === "string") out.push(rec);
    for (const v of Object.values(rec)) {
      if (Array.isArray(v)) v.forEach((c) => flatten(c, out));
      else if (v && typeof v === "object") flatten(v, out);
    }
    return out;
  }
  const typesOf = (md: string) => flatten(convert(md)).map((n) => String(n.type));
  void typesOf; // 保留给以后按类型清单写断言时用；目前每条都直接看节点字段


  it("★ 产出的是一个 `mermaid` 节点（不是代码块），源码原样保住", () => {
    const all = flatten(convert(["```mermaid", "flowchart LR", "  A-->B", "```"].join("\n")));
    const mermaid = all.filter((n) => n.type === "mermaid");
    expect(mermaid).toHaveLength(1);
    expect(String(mermaid[0].src)).toContain("flowchart LR");
    expect(String(mermaid[0].src)).toContain("A-->B");
    // 反例守卫：这条路径上**不许**再出现代码块（旧行为就是把 ```mermaid 吃成 code）
    expect(all.some((n) => n.type === "code" || n.type === "shuyo-code")).toBe(false);
  });

  it("★ 围栏之后的内容**没有被吞掉**（regExpEnd 必须收紧）", () => {
    const all = flatten(convert(["```mermaid", "flowchart LR", "```", "", "后面的段落"].join("\n")));
    expect(all.filter((n) => n.type === "mermaid")).toHaveLength(1);
    expect(JSON.stringify(all)).toContain("后面的段落");
  });

  it("★ 对照：```js 仍然是代码块（没被这条抢走）", () => {
    const all = flatten(convert(["```js", "const a = 1;", "```"].join("\n")));
    expect(all.filter((n) => n.type === "mermaid")).toHaveLength(0);
    expect(all.some((n) => (n.type === "code" || n.type === "shuyo-code") && n.language === "js")).toBe(true);
  });

  it("★ 没有闭合的 ```mermaid 退回代码块（不许吞掉后文）", () => {
    const all = flatten(convert(["```mermaid", "flowchart LR", "", "没闭合就到这里"].join("\n")));
    expect(all.filter((n) => n.type === "mermaid")).toHaveLength(0);
    expect(JSON.stringify(all)).toContain("没闭合就到这里");
  });

  it("★ 反向：mermaid 节点导出回 ```mermaid 围栏（往返不丢）", () => {
    const editor = createEditor({
      namespace: "mermaid-export",
      nodes,
      onError: (e) => {
        throw e;
      },
    });
    let md = "";
    editor.update(
      () => {
        $convertFromMarkdownString(
          ["```mermaid", "flowchart LR", "  A-->B", "```"].join("\n"),
          SHUYONOTE_TRANSFORMERS,
          $getRoot(),
        );
        md = $convertToMarkdownString(SHUYONOTE_TRANSFORMERS);
      },
      { discrete: true },
    );
    expect(md).toContain("```mermaid");
    expect(md).toContain("flowchart LR");
  });

  it("★ 缩进必须原样保住（owner 2026-10-07：「原始 md 文档有缩进，你转换时丢掉了」✗）", () => {
    // 来由：owner 的 md 原稿里 mindmap 是**分层缩进**的 ✓，而存进应用的内容里缩进**全没了** ✗
    //   ⇒ 图被 mermaid 当成"所有节点都是根" ⇒ 报 `There can be only one root` ✓。
    //   ⚠️ 上面那条老判据（"源码原样保住" ✓）用的是 `"  A-->B"`，但只断言 `toContain("A-->B")`
    //      ⇒ **它一直容忍缩进丢失** ✗ —— 这条补上那个缺口 ✓。
    const md = ["```mermaid", "mindmap", "  root((R))", "    甲", "      乙", "```"].join("\n");
    const all = flatten(convert(md));
    const node = all.find((n) => n.type === "mermaid");
    expect(node).toBeTruthy();
    const src = String(node?.src ?? "");
    // 逐行断言：第二行两格、第三行四格、第四行六格 —— 一格都不许少 ✓
    expect(src.split("\n").slice(1, 4)).toEqual(["  root((R))", "    甲", "      乙"]);
  });
  it('★ HTML 预处理不许吃掉围栏里的缩进（owner：「json 代码转换后缩进也没了」）', () => {
    // 来由：`preprocessMarkdownImport` 一旦在文档里发现**任何 HTML 标签**（HTML_RE ✓），
    //   就把**整篇 md** 丢给 `DOMParser` 解析 —— 而 ```json / ```mermaid 围栏**不是 <pre>**
    //   ⇒ HTML 解析器先把连续空格折成一个，`nodeToMarkdown` 的元素分支再折一次 ✗
    //   ⇒ 围栏里用来表达结构的缩进**全没了** ✓（这正是 owner 连报两次的那件事 ✓）。
    const md = [
      '<div>前面有 HTML ⇒ 整篇会走 HTML 解析</div>',
      '',
      '```json',
      '{',
      '  "a": 1,',
      '  "b": {',
      '    "c": 2',
      '  }',
      '}',
      '```',
      '',
      '```mermaid',
      'mindmap',
      '  root((R))',
      '    甲',
      '```',
    ].join('\n');
    const pre = preprocessMarkdownImport(md);
    // ① 围栏里的缩进必须原样（JSON 的每一层 ✓、mermaid 的层级 ✓）
    expect(pre).toContain('  "a": 1,');
    expect(pre).toContain('    "c": 2');
    expect(pre).toContain('  root((R))');
    expect(pre).toContain('    甲');
    // ② 而且 HTML 那一半该转的还是要转（别为了保缩进把 HTML 处理整条关掉 ✗）
    expect(pre).not.toContain('<div>');
    expect(pre).toContain('前面有 HTML');
  });
});
