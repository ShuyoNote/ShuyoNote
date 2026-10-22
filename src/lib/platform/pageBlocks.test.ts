// `pageBlocksFromDoc`：`get_page_blocks` 的**唯一实现**，也是 **04 阅读屏唯一的正文来源**。
//
// ⭐ 这条测试的来由是一次**用户可见的真错**（2026-10-10）：04 阅读屏对**有正文的页**显示
//    「这一页还没有内容」✗ —— 因为实现要求顶层块**必须有 `blockId`**，而**真实存下来的
//    普通页面根本没有这个字段** ✗（实测：`root.children.length = 1`，而该子节点的键里
//    没有 `blockId` ✓）。
//
// ⇒ 所以这里的**主判据**就是那一句：**一条有正文的页 ⇒ 块数 > 0 且文本非空** ✓。
//    下面第 ① 条用的就是**实测抓到的真实形状**（顶层块无 `blockId` ✗）——
//    它在修之前**必红** ✓、修之后**必绿** ✓（两次读数都记在报告里 ✓）。
import { describe, expect, it } from "vitest";
import { pageBlocksFromDoc } from "./pageBlocks";

/** 实测抓到的真实形状：顶层 `paragraph` **没有** `blockId` ✗（键与线上一致 ✓）。 */
const REAL_SHAPE = JSON.stringify({
  root: {
    children: [
      {
        children: [{ detail: 0, format: 0, mode: "normal", style: "", text: "The apple is red.", type: "text", version: 1 }],
        direction: "ltr",
        format: "",
        indent: 0,
        type: "paragraph",
        version: 1,
        textFormat: 0,
        textStyle: "",
      },
    ],
    direction: "ltr",
    format: "",
    indent: 0,
    type: "root",
    version: 1,
  },
});

describe("pageBlocksFromDoc（04 阅读屏的正文来源）", () => {
  it("① ★ 有正文的页（真实形状：顶层块**没有 blockId**）⇒ 块数 > 0 且文本非空", () => {
    const blocks = pageBlocksFromDoc(REAL_SHAPE);
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks[0].text).toBe("The apple is red.");
    expect(blocks[0].block_id).toBeTruthy();
  });

  it("② 被块引用过的块（**有** `blockId`）⇒ 用它自己那个 id", () => {
    const withId = JSON.stringify({
      root: {
        children: [
          { blockId: "b-real-1", type: "paragraph", children: [{ text: "有 id 的块", type: "text" }] },
        ],
      },
    });
    // ⚠️ 2026-10-22 起契约里还有 kind/items（深层相等会把新字段算成"多了一个键"⇒ 用 matchObject 钉"该有的有"）
    expect(pageBlocksFromDoc(withId)).toMatchObject([{ block_id: "b-real-1", text: "有 id 的块", kind: "paragraph" }]);
  });

  it("③ 多块 ⇒ 顺序不变，且空文本的块不收（屏上「本页共 N 块」要数真内容 ✓）", () => {
    const doc = JSON.stringify({
      root: {
        children: [
          { type: "paragraph", children: [{ text: "甲", type: "text" }] },
          { type: "paragraph", children: [] },
          { type: "paragraph", children: [{ text: "乙", type: "text" }] },
        ],
      },
    });
    expect(pageBlocksFromDoc(doc).map((b) => b.text)).toEqual(["甲", "乙"]);
  });

  it("④ 坏 JSON ⇒ 空数组，不抛（平台上一条坏文档不该把整屏带崩 ✓）", () => {
    expect(pageBlocksFromDoc("{ not json")).toEqual([]);
    expect(pageBlocksFromDoc("")).toEqual([]);
  });
});

// ⭐ 2026-10-22（owner：「移动阅读屏的页面样式没有了？」）：**除 text 之外还必须给出块类型**。
//   没有 kind 的时候，前端只能一律 `<p>` ⇒ 标题不加粗、callout 丢底色、引用丢蓝条、
//   **列表各项被粘成一行**（`nodeText` 拼子节点没有分隔符）。这三条钉住"契约里必须有 kind/items"。
describe("pageBlocksFromDoc · 块类型（kind / items）", () => {
  const DOC = JSON.stringify({
    root: {
      children: [
        // 标题的**真形状**：type=heading ＋ tag=h1（⛔ 不是 type:"h1"）
        { type: "heading", tag: "h1", children: [{ type: "text", text: "欢迎来到你的新空间" }] },
        { type: "callout", children: [{ type: "paragraph", children: [{ type: "text", text: "本地优先" }] }] },
        { type: "heading", tag: "h2", children: [{ type: "text", text: "从这里开始" }] },
        {
          type: "list",
          tag: "ul",
          listType: "bullet",
          children: [
            { type: "listitem", children: [{ type: "text", text: "甲" }] },
            { type: "listitem", children: [{ type: "text", text: "乙" }] },
          ],
        },
        { type: "quote", children: [{ type: "text", text: "引用一句" }] },
        { type: "image", children: [] },
      ],
    },
  });

  it("① kind 来自真形状（heading 取 tag），顺序与块顺序一致", () => {
    const kinds = pageBlocksFromDoc(DOC).map((b) => b.kind);
    expect(kinds).toEqual(["h1", "callout", "h2", "list", "quote", "image"]);
  });

  it("② 列表逐项给出来（text 仍是粘着的 —— 语义没改，所以不许拿 text 切）", () => {
    const list = pageBlocksFromDoc(DOC).find((b) => b.kind === "list")!;
    expect(list.items).toEqual(["甲", "乙"]);
    expect(list.text).toBe("甲乙");
  });

  it("③ 图片块（没有文字）不许被丢掉 —— 它代表\"这里有一张图\"的位置", () => {
    const img = pageBlocksFromDoc(DOC).find((b) => b.kind === "image");
    expect(img, "图片块被丢了").toBeTruthy();
    expect(img!.text).toBe("");
  });

  it("④ 认不出来的 type 原样带出去（前端自己兜样式，⛔ 不许丢块）", () => {
    const doc = JSON.stringify({ root: { children: [{ type: "someFutureBlock", children: [{ type: "text", text: "将来的块" }] }] } });
    const b = pageBlocksFromDoc(doc);
    expect(b).toHaveLength(1);
    expect(b[0].kind).toBe("someFutureBlock");
  });
});
