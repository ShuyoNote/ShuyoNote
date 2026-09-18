// 第 3 步的判据：**新建**的段落也要变成模型段落（`shuyo-paragraph` + 声明块 ID）。
//
// 为什么这条判据重要：如果只有"加载的老内容"进模型，而**会话里新建**的块还是老类型，
// 那这些块在 CRDT 平面里就**没有稳定身份** —— 换 CRDT 后重铸 ID、块引用会断。
// 这里用真 `createEditor` + 真 `EDITOR_NODES`，把**变换本体**（不走 React）挂上去验。

import { describe, expect, it } from "vitest";
import { $createParagraphNode, $createTextNode, $getRoot, ParagraphNode, createEditor } from "lexical";
import { $createHeadingNode, HeadingNode } from "@lexical/rich-text";

import { EDITOR_NODES } from "./config";
import { upgradeHeadingToBlockNode, upgradeParagraphToBlockNode } from "./blockIdTransform";
import { $createBlockParagraphNode } from "./nodes/BlockParagraphNode";

function editorWithTransform() {
  const editor = createEditor({ nodes: EDITOR_NODES, namespace: "blockid-transform-test" });
  editor.registerNodeTransform(ParagraphNode, upgradeParagraphToBlockNode);
  editor.registerNodeTransform(HeadingNode, upgradeHeadingToBlockNode);
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
});
