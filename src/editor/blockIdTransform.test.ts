// 第 3 步的判据：**新建**的段落也要变成模型段落（`shuyo-paragraph` + 声明块 ID）。
//
// 为什么这条判据重要：如果只有"加载的老内容"进模型，而**会话里新建**的块还是老类型，
// 那这些块在 CRDT 平面里就**没有稳定身份** —— 换 CRDT 后重铸 ID、块引用会断。
// 这里用真 `createEditor` + 真 `EDITOR_NODES`，把**变换本体**（不走 React）挂上去验。

import { describe, expect, it } from "vitest";
import { $createParagraphNode, $createTextNode, $getRoot, ParagraphNode, createEditor } from "lexical";
import { $createHeadingNode, $createQuoteNode, HeadingNode, QuoteNode } from "@lexical/rich-text";
import { $createTableNodeWithDimensions } from "@lexical/table";
import { TableNode } from "@lexical/table";
import { $createListItemNode, $createListNode, ListNode } from "@lexical/list";

import { EDITOR_NODES } from "./config";
import {
  ensureBlockIdOnTopLevelNode,
  upgradeCodeToBlockNode,
  upgradeHeadingToBlockNode,
  upgradeHorizontalRuleToBlockNode,
  upgradeListToBlockNode,
  upgradeParagraphToBlockNode,
  upgradeQuoteToBlockNode,
  upgradeTableToBlockNode,
} from "./blockIdTransform";
import { $createCalloutNode, CalloutNode } from "./nodes/CalloutNode";
import { $createBlockParagraphNode } from "./nodes/BlockParagraphNode";
import { $createSafeCodeNode, SafeCodeNode } from "./nodes/SafeCodeNode";
import { $createHorizontalRuleNode, HorizontalRuleNode } from "@lexical/react/LexicalHorizontalRuleNode";
import { toLegacyDoc } from "../lib/blockIdentity";

function editorWithTransform() {
  const editor = createEditor({ nodes: EDITOR_NODES, namespace: "blockid-transform-test" });
  editor.registerNodeTransform(ParagraphNode, upgradeParagraphToBlockNode);
  editor.registerNodeTransform(HeadingNode, upgradeHeadingToBlockNode);
  editor.registerNodeTransform(QuoteNode, upgradeQuoteToBlockNode);
  editor.registerNodeTransform(ListNode, upgradeListToBlockNode);
  editor.registerNodeTransform(SafeCodeNode, upgradeCodeToBlockNode);
  editor.registerNodeTransform(HorizontalRuleNode, upgradeHorizontalRuleToBlockNode);
  editor.registerNodeTransform(TableNode, upgradeTableToBlockNode);
  editor.registerNodeTransform(CalloutNode, ensureBlockIdOnTopLevelNode);
  return editor;
}

const rootChildren = (editor: ReturnType<typeof editorWithTransform>) =>
  (editor.getEditorState().toJSON() as { root: { children: Array<Record<string, unknown>> } }).root.children;

describe("第 3 步：新建段落自动升级成模型段落", () => {
  it("★ 内建工厂造出来的段落 → 变成 `shuyo-paragraph` 且**带块 ID**，文字不丢", () => {
    const editor = editorWithTransform();
    editor.update(() => {
      const p = $createParagraphNode(); // 老类型（粘贴/markdown/HTML 都走它）
      p.append($createTextNode("粘贴进来的文字"));
      $getRoot().append(p);
    }, { discrete: true });

    const kids = rootChildren(editor);
    expect(kids[0].type).toBe("shuyo-paragraph");
    expect(typeof kids[0].blockId).toBe("string");
    expect((kids[0].blockId as string).length).toBeGreaterThan(0);
    // 子节点必须跟着搬过去（`node.replace(replacement, true)` 的 `true` 就是这件事；
    // 漏了它段落会变空，是这条判据真正在守的回归）。
    expect(JSON.stringify(kids[0].children)).toContain("粘贴进来的文字");
  });

  it("属性跟着搬：对齐 / 缩进 / 文本格式一个不丢", () => {
    const editor = editorWithTransform();
    editor.update(() => {
      const p = $createParagraphNode();
      const t = $createTextNode("居中加粗");
      t.toggleFormat("bold");
      p.append(t);
      p.setFormat("center");
      p.setIndent(2);
      $getRoot().append(p);
    }, { discrete: true });

    const kid = rootChildren(editor)[0];
    // ⚠️ 对齐必须按**字符串**抄（`getFormatType()`）：0.50 的 `getFormat()` 返回数字，
    // 抄错会让对齐样式静默丢失 —— 这条判据就是为它立的。
    expect(kid.format).toBe("center");
    expect(kid.indent).toBe(2);
    // 文本自身的格式在**文本子节点**上（0.50 里段落的 textFormat 是按第一个文本子节点算的）
    const textChild = (kid.children as Array<Record<string, unknown>>)[0];
    expect(textChild.format).toBe(1); // bold
  });

  it("空段落的段落级 textFormat/textStyle 也搬过去（没有文本子节点时它才是权威）", () => {
    const editor = editorWithTransform();
    editor.update(() => {
      const p = $createParagraphNode(); // 故意不加子节点
      p.setTextFormat(1);
      p.setTextStyle("color: red");
      $getRoot().append(p);
    }, { discrete: true });

    const kid = rootChildren(editor)[0];
    expect(kid.textFormat).toBe(1);
    expect(kid.textStyle).toBe("color: red");
  });

  it("★ 已经是模型段的节点**不被动**（块 ID 是稳定身份，编辑过程中绝不许重铸）", () => {
    const editor = editorWithTransform();
    let firstId = "";
    editor.update(() => {
      const p = $createBlockParagraphNode("blk-stable");
      p.append($createTextNode("原有内容"));
      $getRoot().append(p);
      firstId = p.getBlockId();
    }, { discrete: true });
    // 再改一次内容，逼变换再跑一遍
    editor.update(() => {
      ($getRoot().getFirstChild() as never as { getFirstChild: () => { setTextContent: (t: string) => void } })
        .getFirstChild()
        .setTextContent("改过");
    }, { discrete: true });

    const kid = rootChildren(editor)[0];
    expect(firstId).toBe("blk-stable");
    expect(kid.blockId).toBe("blk-stable"); // 没有被重铸
    expect(kid.type).toBe("shuyo-paragraph");
  });

  it("空编辑器的**首个段落**也会被升级（新建空页面一打开就有块 ID）", () => {
    const editor = editorWithTransform();
    editor.update(() => {
      const p = $createParagraphNode();
      $getRoot().append(p);
    }, { discrete: true });
    expect(rootChildren(editor)[0].type).toBe("shuyo-paragraph");
  });

  it("★ 标题也被升级：type 变 `shuyo-heading`、**tag 保住**、带块 ID、文字不丢", () => {
    const editor = editorWithTransform();
    editor.update(() => {
      const h = $createHeadingNode("h2"); // 老类型（markdown 导入 / 粘贴 / 工具栏都走它）
      h.append($createTextNode("二级标题"));
      $getRoot().append(h);
    }, { discrete: true });

    const kid = rootChildren(editor)[0];
    expect(kid.type).toBe("shuyo-heading");
    expect(kid.tag).toBe("h2"); // tag 是节点自己的状态，抄漏了 h2 会变成 h1
    expect(typeof kid.blockId).toBe("string");
    expect((kid.blockId as string).length).toBeGreaterThan(0);
    expect(JSON.stringify(kid.children)).toContain("二级标题");
  });

  it("标题与段落**各归各的变换**，互不误伤", () => {
    const editor = editorWithTransform();
    editor.update(() => {
      const h = $createHeadingNode("h1");
      h.append($createTextNode("标题"));
      const p = $createParagraphNode();
      p.append($createTextNode("段落"));
      $getRoot().append(h, p);
    }, { discrete: true });

    const [h, p] = rootChildren(editor);
    expect(h.type).toBe("shuyo-heading");
    expect(p.type).toBe("shuyo-paragraph");
    expect(h.blockId).not.toBe(p.blockId); // 两块各有各的 ID
  });

  it("★ 嵌套段落（表格单元格里的）升级**类型**但**不给块 ID** ⇒ 落盘形态不添噪音", () => {
    // ⚠️ 用表格当"嵌套"的载体：Lexical 的**列表项会把段落拆直**（列表项里直接是文本），
    // 所以拿列表测"嵌套段落"其实测不到东西 —— 表格单元格里才是真的嵌套段落。
    const editor = editorWithTransform();
    editor.update(() => {
      $getRoot().append($createTableNodeWithDimensions(1, 1, false));
    }, { discrete: true });

    /** 深度 > 1 的第一个模型段落（顶层是 table）。 */
    const findDeep = (nodes: Array<Record<string, unknown>>, depth = 1): Record<string, unknown> | null => {
      for (const n of nodes) {
        if (depth > 1 && n.type === "shuyo-paragraph") return n;
        const kids = n.children as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(kids)) {
          const hit = findDeep(kids, depth + 1);
          if (hit) return hit;
        }
      }
      return null;
    };

    const deep = findDeep(rootChildren(editor));
    expect(deep).not.toBeNull();
    expect(deep?.type).toBe("shuyo-paragraph"); // 类型升级了
    expect(deep?.blockId).toBeUndefined(); // 但**没有**块身份（今天只有顶层块有）

    // 落盘形态里**只有顶层块**带 `blockId`（这里顶层 table 已迁移 ⇒ 恰好 1 处；
    // 单元格里的那个段落一处都不算）。这条断言比"整份文档里没有 blockId"更耐久 ——
    // 随着更多顶层类型迁移，"一个都没有"迟早会变成错的（表格迁移时它就红过一次）。
    const wire = toLegacyDoc(JSON.stringify({ root: { children: rootChildren(editor) } }));
    expect(wire.split('"blockId"').length - 1).toBe(1);
  });

  it("★ 引用也被升级：type 变 `shuyo-quote`、带块 ID、文字不丢", () => {    const editor = editorWithTransform();
    editor.update(() => {
      const q = $createQuoteNode(); // 老类型（markdown 导入 `> ` / 工具栏都走它）
      q.append($createTextNode("引用一行"));
      $getRoot().append(q);
    }, { discrete: true });

    const kid = rootChildren(editor)[0];
    expect(kid.type).toBe("shuyo-quote");
    expect(typeof kid.blockId).toBe("string");
    expect((kid.blockId as string).length).toBeGreaterThan(0);
    expect(JSON.stringify(kid.children)).toContain("引用一行");
  });

  it("★ 列表也被升级：type 变 `shuyo-list`、`listType`/`tag`/`start` 三态都保住、带块 ID", () => {
    const editor = editorWithTransform();
    editor.update(() => {
      const list = $createListNode("number"); // 老类型（markdown 的 `1. ` / 工具栏都走它）
      list.setStart(5); // "从 5 开始编号" —— 抄漏它会静默变回 1
      const item = $createListItemNode();
      item.append($createTextNode("第五项"));
      list.append(item);
      $getRoot().append(list);
    }, { discrete: true });

    const kid = rootChildren(editor)[0];
    expect(kid.type).toBe("shuyo-list");
    expect(kid.listType).toBe("number");
    expect(kid.tag).toBe("ol");
    expect(kid.start).toBe(5);
    expect(typeof kid.blockId).toBe("string");
    expect((kid.blockId as string).length).toBeGreaterThan(0);
    expect(JSON.stringify(kid.children)).toContain("第五项");
  });

  it("★ 代码块也被升级：type 变 `shuyo-code`、**语言保住**、带块 ID、文字不丢", () => {
    const editor = editorWithTransform();
    editor.update(() => {
      // ⚠️ 用应用的 `$createSafeCodeNode`（**不要**用内建 `$createCodeNode`：
      // `SafeCodeNode` 是同 type（`"code"`）子类，内建工厂在 0.50 会抛 type/class 不匹配）。
      const code = $createSafeCodeNode("python");
      code.append($createTextNode("print(1)"));
      $getRoot().append(code);
    }, { discrete: true });

    const kid = rootChildren(editor)[0];
    expect(kid.type).toBe("shuyo-code");
    expect(kid.language).toBe("python"); // 抄漏语言 ⇒ 高亮退回默认
    expect(typeof kid.blockId).toBe("string");
    expect((kid.blockId as string).length).toBeGreaterThan(0);
    expect(JSON.stringify(kid.children)).toContain("print(1)");
  });

  it("★ 水平线也被升级：type 变 `shuyo-horizontalrule`、带块 ID", () => {
    const editor = editorWithTransform();
    editor.update(() => {
      $getRoot().append($createHorizontalRuleNode());
    }, { discrete: true });

    const kid = rootChildren(editor)[0];
    expect(kid.type).toBe("shuyo-horizontalrule");
    expect(typeof kid.blockId).toBe("string");
    expect((kid.blockId as string).length).toBeGreaterThan(0);
  });

  it("★ 表格也被升级：type 变 `shuyo-table`、带块 ID、**行列结构原样**", () => {
    const editor = editorWithTransform();
    editor.update(() => {
      $getRoot().append($createTableNodeWithDimensions(2, 2, true));
    }, { discrete: true });

    const kid = rootChildren(editor)[0];
    expect(kid.type).toBe("shuyo-table");
    expect(typeof kid.blockId).toBe("string");
    expect((kid.blockId as string).length).toBeGreaterThan(0);
    const rows = kid.children as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2); // 两行
    expect((rows[0].children as unknown[])).toHaveLength(2); // 每行两格
  });

  it("★ 自有节点（callout）：**类型不变**、新建的顶层块拿到块 ID", () => {
    // 自有点节与内建类型的路子不同：类就是类型 ⇒ **不需要新 type、不需要映射**，
    // 只要类里有声明字段 + `ensureBlockIdOnTopLevelNode` 给新建的顶层块补 ID。
    const editor = editorWithTransform();
    editor.update(() => {
      $getRoot().append($createCalloutNode());
    }, { discrete: true });

    const kid = rootChildren(editor)[0];
    expect(kid.type).toBe("callout"); // 类型**不变**（与内建类型不同）
    expect(typeof kid.blockId).toBe("string");
    expect((kid.blockId as string).length).toBeGreaterThan(0);
  });

  it("自有节点的**嵌套**实例不给身份（同一条规则）", () => {
    const editor = editorWithTransform();
    editor.update(() => {
      const outer = $createCalloutNode();
      outer.append($createCalloutNode()); // 嵌套 callout
      $getRoot().append(outer);
    }, { discrete: true });

    const outer = rootChildren(editor)[0];
    const inner = (outer.children as Array<Record<string, unknown>>)[0];
    expect(typeof outer.blockId).toBe("string"); // 顶层有
    expect(inner.blockId).toBeUndefined(); // 嵌套没有
  });
});
