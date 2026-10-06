// `hasBlockContent` 的判据 —— 它决定"要不要显示新页面引导"（owner 2026-10-06：「指引内容没有了」）。
//
// 这里钉的是一条**真实事故**：旧口径只数 `root.children.length > 0`，
// 而编辑器一打开/自动保存就会把空文档写成"一个空段落"
// ⇒ 新建页面**立刻**被判成"有内容" ⇒ 引导根本不显示 ✗（真机读数见 `lib/blankPage.ts` 注释）。
// ⚠️ 反向那条同样重要：**只有图片/表格/嵌入**的页面文字是空的，但它**有内容** ——
// 不许因为它文字空就把引导盖上去 ✗（那是老注释里专门写下的一条要求）。
import { describe, expect, it } from "vitest";
import { hasBlockContent } from "./blankPage";

const doc = (children: unknown[]) => JSON.stringify({ root: { type: "root", children } });
const para = (text: string) => ({
  type: "paragraph",
  children: [{ type: "text", text }],
});

describe("hasBlockContent：这一页到底有没有内容", () => {
  it("空字符串 / `{}` / 空 children ⇒ 没有内容（引导该显示）", () => {
    expect(hasBlockContent("")).toBe(false);
    expect(hasBlockContent("{}")).toBe(false);
    expect(hasBlockContent(doc([]))).toBe(false);
    expect(hasBlockContent('{"root":{}}')).toBe(false);
  });

  it("★ **一个空段落也算空页**（这就是「引导一闪就没」的那个 bug）", () => {
    expect(hasBlockContent(doc([para("")]))).toBe(false);
    expect(hasBlockContent(doc([para("   ")]))).toBe(false);
    // 空标题 / 空引用 / 空列表 同理
    expect(hasBlockContent(doc([{ type: "heading", children: [{ type: "text", text: "" }] }]))).toBe(false);
    expect(hasBlockContent(doc([{ type: "list", children: [{ type: "listitem", children: [para("")] }] }]))).toBe(false);
  });

  it("有非空白文字 ⇒ 有内容", () => {
    expect(hasBlockContent(doc([para("写点东西")]))).toBe(true);
    // 顶层空段落 + 第二个段落里有字 ⇒ 有内容
    expect(hasBlockContent(doc([para(""), para("有字")]))).toBe(true);
    // 嵌套里才有的字也要能看见
    expect(hasBlockContent(doc([{ type: "list", children: [{ type: "listitem", children: [para("嵌套里的字")] }] }]))).toBe(true);
  });

  it("★ 只有图片 / 表格 / 嵌入（文字是空的）⇒ **仍然算有内容**（不许把引导盖上去 ✗）", () => {
    expect(hasBlockContent(doc([{ type: "image", children: [] }]))).toBe(true);
    expect(hasBlockContent(doc([{ type: "shuyo-table", children: [] }]))).toBe(true);
    expect(hasBlockContent(doc([{ type: "blockEmbed", children: [] }]))).toBe(true);
    // 非节点数组不当节点走：`imageRow` 靠 **type** 判（它 ∉ 空壳 ✓），不靠递归 `items`
    expect(hasBlockContent(doc([{ type: "imageRow", items: [{ src: "a.png" }], children: [] }]))).toBe(true);
  });

  it("不是 JSON ⇒ 非空即「有内容」（坏文档不许被当成空页，否则引导会盖住用户内容 ✗）", () => {
    expect(hasBlockContent("这不是 JSON")).toBe(true);
    expect(hasBlockContent("   ")).toBe(false);
  });
});
