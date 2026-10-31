// 选中工具条「块类型下拉」的判据（正文 ↔ 标题 1–3）。
//
// 为什么单独钉：这个转换**最容易伤到块 ID**（`((blockId))` 引用、CRDT 身份都靠它）。
// 斜杠菜单那套 `$replaceBlock` 是"新造一个节点再 replace"，块 ID 会换；
// 工具条这里用的是 `$convertSelectedBlocksTo`（保留 blockId / 只换外层类型）——
// 下面几条就是把它钉死：**类型变了、ID 没变、文字没丢**。
import { describe, expect, it } from "vitest";
import {
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $setSelection,
  createEditor,
  ParagraphNode,
  type LexicalEditor,
} from "lexical";
import { HeadingNode } from "@lexical/rich-text";

import { EDITOR_NODES } from "./config";
import { $blockTypeOf, $convertSelectedBlocksTo } from "./blockType";
import { upgradeHeadingToBlockNode, upgradeParagraphToBlockNode } from "./blockIdTransform";
import { $createBlockHeadingNode } from "./nodes/BlockHeadingNode";
import { $createBlockParagraphNode } from "./nodes/BlockParagraphNode";

function editorWithTransforms(): LexicalEditor {
  const editor = createEditor({ nodes: EDITOR_NODES, namespace: "blocktype-test" });
  editor.registerNodeTransform(ParagraphNode, upgradeParagraphToBlockNode);
  editor.registerNodeTransform(HeadingNode, upgradeHeadingToBlockNode);
  return editor;
}

function paragraphWithText(blockId: string, text: string) {
  const p = $createBlockParagraphNode(blockId);
  p.append($createTextNode(text));
  return p;
}

/** 把选区设成 `from` 文本开头 → `to` 文本结尾，然后执行转换。 */
function convertBetween(fromTextKey: string, fromOffset: number, toTextKey: string, toOffset: number, target: "p" | "h1" | "h2" | "h3") {
  const range = $createRangeSelection();
  range.anchor.set(fromTextKey, fromOffset, "text");
  range.focus.set(toTextKey, toOffset, "text");
  $setSelection(range);
  return $convertSelectedBlocksTo(range, target);
}

describe("块类型转换（选中工具条下拉）", () => {
  it("① 正文 → 标题 2：块 ID 保留、文字保留、tag 变 h2", () => {
    const editor = editorWithTransforms();
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      const p = paragraphWithText("b1", "一段正文");
      root.append(p);
      const t = p.getFirstChild()!;
      expect(convertBetween(t.getKey(), 0, t.getKey(), t.getTextContentSize(), "h2")).toBe(1);
    }, { discrete: true });
    editor.getEditorState().read(() => {
      const child = $getRoot().getFirstChild();
      expect(child?.getType()).toBe("shuyo-heading");
      expect((child as unknown as { getTag(): string }).getTag()).toBe("h2");
      expect((child as unknown as { getBlockId(): string }).getBlockId()).toBe("b1");
      expect(child?.getTextContent()).toBe("一段正文");
    });
  });

  it("② 标题 1 → 正文：块 ID 保留、文字保留", () => {
    const editor = editorWithTransforms();
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      const h = $createBlockHeadingNode("h1", "h1-id");
      h.append($createTextNode("一个标题"));
      root.append(h);
      const t = h.getFirstChild()!;
      expect(convertBetween(t.getKey(), 0, t.getKey(), t.getTextContentSize(), "p")).toBe(1);
    }, { discrete: true });
    editor.getEditorState().read(() => {
      const child = $getRoot().getFirstChild();
      expect(child?.getType()).toBe("shuyo-paragraph");
      expect((child as unknown as { getBlockId(): string }).getBlockId()).toBe("h1-id");
      expect(child?.getTextContent()).toBe("一个标题");
    });
  });

  it("③ 跨两个块选中 ⇒ 两块一起转，各自的块 ID 都保留", () => {
    const editor = editorWithTransforms();
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      const p1 = paragraphWithText("b1", "第一段");
      const p2 = paragraphWithText("b2", "第二段");
      root.append(p1, p2);
      const t1 = p1.getFirstChild()!;
      const t2 = p2.getFirstChild()!;
      expect(convertBetween(t1.getKey(), 0, t2.getKey(), t2.getTextContentSize(), "h3")).toBe(2);
    }, { discrete: true });
    editor.getEditorState().read(() => {
      const kids = $getRoot().getChildren();
      expect(kids).toHaveLength(2);
      for (const [i, id] of ["b1", "b2"].entries()) {
        const k = kids[i];
        expect(k.getType()).toBe("shuyo-heading");
        expect((k as unknown as { getTag(): string }).getTag()).toBe("h3");
        expect((k as unknown as { getBlockId(): string }).getBlockId()).toBe(id);
        expect(k.getTextContent()).toBe(i === 0 ? "第一段" : "第二段");
      }
    });
  });

  it("④ 已经是目标类型 ⇒ 不改（返回 0），块 ID 也不动", () => {
    const editor = editorWithTransforms();
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      const p = paragraphWithText("b1", "正文");
      root.append(p);
      const t = p.getFirstChild()!;
      expect($blockTypeOf(t)).toBe("p");
      expect(convertBetween(t.getKey(), 0, t.getKey(), t.getTextContentSize(), "p")).toBe(0);
    });
  });

  it("⑤ 标题 tag 读数：h1/h2/h3 各自认得，正文给 p", () => {
    const editor = editorWithTransforms();
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      const p = paragraphWithText("b1", "x");
      const h1 = $createBlockHeadingNode("h1", "b2");
      h1.append($createTextNode("y"));
      const h3 = $createBlockHeadingNode("h3", "b3");
      h3.append($createTextNode("z"));
      root.append(p, h1, h3);
      expect($blockTypeOf(p)).toBe("p");
      expect($blockTypeOf(h1)).toBe("h1");
      expect($blockTypeOf(h3)).toBe("h3");
    }, { discrete: true });
  });
});



