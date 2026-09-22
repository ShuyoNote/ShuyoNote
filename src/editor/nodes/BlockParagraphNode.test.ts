// 模型段落节点自身的判据（不是变换、不是两形态层）：
//   · **脏化克隆**（`setFormat` 之类会让 Lexical 用 `getWritable()` 克隆一次）后，声明字段不许丢；
//   · JSON 往返保留 `blockId`（CRDT 绑定就是靠 `exportJSON`/`importJSON` 同步的）；
//   · 回车分行（`insertNewAfter`）产出的新块**也是**模型类型。
//
// 为什么第一条要单独钉：0.50 的克隆走 `$config`/`afterCloneFrom` 那套机制，**不是**每个类都必须写
// `static clone`。一旦声明字段没被搬过去，块 ID 会在"用户随手改了下对齐"时**静默变成空串**
// —— 那正是换 CRDT 后块引用会断的那类事故，而且测试不测就看不见。

import { describe, expect, it } from "vitest";
import { $createTextNode, $getRoot, createEditor, type LexicalEditor } from "lexical";

import { EDITOR_NODES } from "../config";
import { $createBlockParagraphNode } from "./BlockParagraphNode";

function newEditor(): LexicalEditor {
  return createEditor({ nodes: EDITOR_NODES, namespace: "block-paragraph-node-test" });
}

const firstChild = (editor: LexicalEditor) =>
  (editor.getEditorState().toJSON() as { root: { children: Array<Record<string, unknown>> } }).root.children[0];

describe("BlockParagraphNode", () => {
  it("★ 脏化克隆（getWritable）之后，声明字段 `blockId` **不能丢**", () => {
    const editor = newEditor();
    editor.update(() => {
      const p = $createBlockParagraphNode("blk-x");
      p.append($createTextNode("内容"));
      $getRoot().append(p);
    }, { discrete: true });
    // 第二次 update 里改属性 ⇒ Lexical 必须先克隆这个节点
    editor.update(() => {
      const p = $getRoot().getFirstChild() as unknown as { setFormat: (f: "center") => void };
      p.setFormat("center");
    }, { discrete: true });

    const kid = firstChild(editor);
    expect(kid.blockId).toBe("blk-x");
    expect(kid.format).toBe("center");
  });

  it("JSON 往返（importJSON/exportJSON）保留 `blockId`（CRDT 绑定就靠这两个）", () => {
    const editor = newEditor();
    const json = JSON.stringify({
      root: {
        children: [
          {
            blockId: "blk-json",
            children: [{ detail: 0, format: 0, mode: "normal", style: "", text: "文字", type: "text", version: 1 }],
            direction: "ltr", format: "", indent: 0, type: "shuyo-paragraph", version: 1,
          },
        ],
        direction: "ltr", format: "", indent: 0, type: "root", version: 1,
      },
    });
    editor.setEditorState(editor.parseEditorState(json));
    const kid = firstChild(editor);
    expect(kid.type).toBe("shuyo-paragraph");
    expect(kid.blockId).toBe("blk-json");
  });

  it("回车分行（insertNewAfter）产出的新块也是模型类型、且带自己的块 ID", () => {
    const editor = newEditor();
    let newType = "";
    let newId = "";
    editor.update(() => {
      const p = $createBlockParagraphNode("blk-a");
      p.append($createTextNode("第一段"));
      $getRoot().append(p);
      p.selectEnd();
      const next = p.insertNewAfter(editor.getEditorState().read(() => null) as never) as unknown as {
        getType: () => string;
        getBlockId: () => string;
      };
      newType = next.getType();
      newId = next.getBlockId();
    }, { discrete: true });

    expect(newType).toBe("shuyo-paragraph");
    expect(newId.length).toBeGreaterThan(0);
    // 新块必须拿到**新的** ID，不能继承上一块的
    expect(newId).not.toBe("blk-a");
  });
});
