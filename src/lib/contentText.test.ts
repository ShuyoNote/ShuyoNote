// 「正文纯文本唯一实现」的判据。
//
// 这条判据钉的是一件**用户看得见**的事：正文纯文本是 FTS 命中、反链片段、列表预览的共同输入，
// 而它原来有**两条**派生（编辑器 `$getRoot().getTextContent()` vs AI/PDF 路径的 walk-JSON 空格连接），
// 实测 7 个样本里 4 个结果不同 ⇒ "谁最后保存"决定搜索片段长什么样。
//
// 现在只有 `deriveContentText` 一条。下面逐类钉：**它与编辑器路径逐字相同**，
// 并且对脏 JSON **不抛**（它坐在保存路径上）。

import { describe, expect, it } from "vitest";
import { $getRoot, createEditor } from "lexical";

import { EDITOR_NODES } from "../editor/config";
import { deriveContentText } from "./contentText";

/** 编辑器保存路径的那一条（与 `Editor.tsx` 同语义）。 */
function editorText(docJson: string): string {
  const editor = createEditor({ nodes: EDITOR_NODES, namespace: "content-text-test", onError: () => {} });
  editor.setEditorState(editor.parseEditorState(docJson));
  return editor.getEditorState().read(() => $getRoot().getTextContent());
}

const text = (t: string) => ({ detail: 0, format: 0, mode: "normal", style: "", text: t, type: "text", version: 1 });
const doc = (children: unknown[]) =>
  JSON.stringify({ root: { children, direction: "ltr", format: "", indent: 0, type: "root", version: 1 } });
const para = (t: string) => ({ children: [text(t)], direction: "ltr", format: "", indent: 0, type: "paragraph", version: 1 });

describe("deriveContentText：与编辑器路径**逐字相同**", () => {
  const cases: Array<[string, string]> = [
    ["单段落", doc([para("一段话")])],
    ["多段落（块间怎么连由 Lexical 定）", doc([para("第一段"), para("第二段")])],
    ["标题+引用", doc([
      { children: [text("一级标题")], direction: "ltr", format: "", indent: 0, tag: "h1", type: "heading", version: 1 },
      { children: [text("引用一行")], direction: "ltr", format: "", indent: 0, type: "quote", version: 1 },
    ])],
    ["嵌套列表", doc([{
      children: [
        { children: [text("第一项")], direction: "ltr", format: "", indent: 0, type: "listitem", value: 1, version: 1 },
      ],
      direction: "ltr", format: "", indent: 0, listType: "bullet", start: 1, tag: "ul", type: "list", version: 1,
    }])],
    ["空页面（一个空段落）", doc([para("")])],
  ];

  for (const [name, json] of cases) {
    it(`${name}：逐字等于编辑器路径`, () => {
      expect(deriveContentText(json)).toBe(editorText(json));
    });
  }

  it("★ 这段文本是**用户看到的**（不是空格拼接）——用一段多块内容把差异钉住", () => {
    const json = doc([para("甲"), para("乙")]);
    const derived = deriveContentText(json);
    expect(derived).toBe(editorText(json));
    // 旧算法是 "甲 乙"；新语义按 Lexical 的块分隔（换行）。这里只断言"与编辑器一致"，
    // 具体的分隔符交给 Lexical —— 但**必须**不是空格拼接那一种。
    expect(derived).not.toBe("甲 乙");
  });

  it("`{}`（应用默认值）⇒ 空串（编辑器路径对它是「空页」，两者不冲突）", () => {
    // ⚠️ 不能拿它跟 `editorText("{}")` 比：`"{}"` 在 Lexical 里**parse 就抛**（空编辑器状态非法），
    // 应用的编辑器路径是先过 `lexicalStateValid` 归一、再走"空页"分支（结果是空文本）。
    // ⇒ 这条只钉"派生不抛、且给空串"。
    expect(deriveContentText("{}")).toBe("");
  });
});

describe("deriveContentText：脏输入**不抛**（它坐在保存路径上）", () => {
  it.each([
    ["空串", ""],
    ["不是 JSON", "{ 这不是 JSON"],
    ["只有 root 但 children 是垃圾", '{"root":{"children":"nope"}}'],
    ["未知节点类型", doc([{ children: [text("x")], type: "nope-not-registered", version: 1 }])],
  ])("%s ⇒ 不抛，返回字符串", (_name, json) => {
    const out = deriveContentText(json as string);
    expect(typeof out).toBe("string");
  });
});
