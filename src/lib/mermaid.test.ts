// `mermaidInitOptions` 的判据 —— 它挡的是**一次真实事故**（2026-10-05 owner 实测）：
// 图块的「下载」报 `Tainted canvases may not be exported.`，PNG 永远导不出去。
//
// 根因：`htmlLabels: false` 被写在 `flowchart: {}` 里 —— **mermaid 11 不认那个位置** ⇒ 仍然产出
// `<foreignObject>` 的 HTML 标签 ⇒ Chromium 把画进 canvas 的 SVG 图片判为 tainted ⇒ `toBlob` 抛错。
// 所以这里逼一条**机器判据**：拿真 mermaid 渲染一段，断言产出里**没有** `<foreignObject>`。
// ⚠️ 只要有人把 `htmlLabels` 挪回 `flowchart` 里、或删掉，这条就会红 ✓
//    （这条同时守住 `mdMermaid.ts` 当初写下的意图："要 SVG text label，布局不依赖宿主 CSS/字体"。）
import { describe, expect, it } from "vitest";
import { centerMindmapRootLabel, mermaidInitOptions, normalizeMindmapIndent } from "./mermaid";

describe("mermaidInitOptions", () => {
  it("顶层就带 `htmlLabels: false`（挪进 `flowchart` 里等于没写）", () => {
    const opts = mermaidInitOptions("default");
    expect(opts.htmlLabels).toBe(false);
    expect((opts.flowchart as Record<string, unknown> | undefined)?.htmlLabels).toBeUndefined();
  });

  it("★ 真渲染一次：产出里**没有 `<foreignObject>`**（有它 canvas 就变脏、PNG 导不出去）", async () => {
    const mermaid = (await import("mermaid")).default;
    mermaid.initialize({ ...mermaidInitOptions("default") } as never);

    const { svg } = await mermaid.render("mermaid-init-test", 'flowchart LR\n  A["一"] --> B["二"]');

    expect(svg).not.toContain("<foreignObject");
    expect(svg).toContain("<text"); // 标签确实是用 SVG text 画的（不是"什么都没渲染"）
  }, 60000);
});

describe("mindmap 没有缩进 ⇒ 按根节点挂（owner 两张截图的真因）", () => {
  const FLAT = ["mindmap", "root((🏠 数友社区))", "长文沉淀", "知乎优质内容同步", "案例库"].join("\n");

  it("★ 报错那篇的真实形状：整体没缩进 ⇒ 除根之外全部缩进两格", () => {
    const { text, autoIndented } = normalizeMindmapIndent(FLAT);
    expect(autoIndented).toBe(true);
    expect(text.split("\n")).toEqual(["mindmap", "root((🏠 数友社区))", "  长文沉淀", "  知乎优质内容同步", "  案例库"]);
  });

  it("已经带缩进 ⇒ 一个字都不动（尊重作者层级 ✓）", () => {
    const src = ["mindmap", "  root((标题))", "    子项", "    另一个子项"].join("\n");
    expect(normalizeMindmapIndent(src)).toEqual({ text: src, autoIndented: false });
  });

  it("不是 mindmap（flowchart / pie）⇒ 一律不动", () => {
    const fc = ["flowchart LR", "A[一] --> B[二]"].join("\n");
    expect(normalizeMindmapIndent(fc)).toEqual({ text: fc, autoIndented: false });
    const pie = ["pie title 占比", '"甲" : 30', '"乙" : 70'].join("\n");
    expect(normalizeMindmapIndent(pie)).toEqual({ text: pie, autoIndented: false });
  });

  it("注释与空行原样保留（⛔ 不把 %% 当成节点 ✗）", () => {
    const src = ["mindmap", "root((R))", "%% 说明", "", "甲", "乙"].join("\n");
    const { text } = normalizeMindmapIndent(src);
    expect(text.split("\n")).toEqual(["mindmap", "root((R))", "%% 说明", "", "  甲", "  乙"]);
  });

  it("空的 / 只有指令 ⇒ 不报错、也不改", () => {
    expect(normalizeMindmapIndent("")).toEqual({ text: "", autoIndented: false });
    expect(normalizeMindmapIndent("mindmap")).toEqual({ text: "mindmap", autoIndented: false });
  });
});
describe("mindmap 的锚点：**只动根节点**（owner：先「中心节点文本偏心了」、再「子节点的文本偏了」）", () => {
  // 真 SVG 的结构（打印真产物得到 ✓）：根那一组 class 里有 `section-root` ✓
  const ROOT_AND_CHILD =
    '<svg><g class="node mindmap-node section-root section--1"><circle r="26"></circle>' +
    '<g class="label"><rect></rect><g><text y="-10">根标签</text></g></g></g>' +
    '<g class="node mindmap-node section--1"><path d="M0 0"></path>' +
    '<g class="label"><g><text y="-10">子节点甲</text></g></g></g></svg>';

  it("★ 只给根那一组的第一个 <text> 补 middle，且**一共只加一个**锚点", () => {
    const out = centerMindmapRootLabel(ROOT_AND_CHILD);
    expect((out.match(/text-anchor="middle"/g) ?? []).length).toBe(1); // ⭐ 关键不变量 ✓
    expect(out).toContain('<text text-anchor="middle" y="-10">根标签</text>');
  });

  it("★★ 子节点的 <text> **一个都不许被改**（我上一版「全补」把它们推歪了 ✗）", () => {
    const out = centerMindmapRootLabel(ROOT_AND_CHILD);
    expect(out).toContain('<text y="-10">子节点甲</text>'); // 原样 ✓（不带锚点 ✓）
  });

  it("没有 section-root（flowchart / pie 等）⇒ 一个字节都不动 ✓", () => {
    const svg = '<svg><text x="10" y="20">甲</text><text x="30" y="20">乙</text></svg>';
    expect(centerMindmapRootLabel(svg)).toBe(svg);
  });

  it("根本来就带锚点 ⇒ 不覆盖 ✓；没有 <text> ⇒ 原样 ✓", () => {
    const anchored = '<svg><g class="section-root"><text text-anchor="start">根</text></g></svg>';
    expect(centerMindmapRootLabel(anchored)).toBe(anchored);
    expect(centerMindmapRootLabel('<svg><g class="section-root"><rect/></g></svg>')).toContain("section-root");
  });
});