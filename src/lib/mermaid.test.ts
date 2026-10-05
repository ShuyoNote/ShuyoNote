// `mermaidInitOptions` 的判据 —— 它挡的是**一次真实事故**（2026-10-05 owner 实测）：
// 图块的「下载」报 `Tainted canvases may not be exported.`，PNG 永远导不出去。
//
// 根因：`htmlLabels: false` 被写在 `flowchart: {}` 里 —— **mermaid 11 不认那个位置** ⇒ 仍然产出
// `<foreignObject>` 的 HTML 标签 ⇒ Chromium 把画进 canvas 的 SVG 图片判为 tainted ⇒ `toBlob` 抛错。
// 所以这里逼一条**机器判据**：拿真 mermaid 渲染一段，断言产出里**没有** `<foreignObject>`。
// ⚠️ 只要有人把 `htmlLabels` 挪回 `flowchart` 里、或删掉，这条就会红 ✓
//    （这条同时守住 `mdMermaid.ts` 当初写下的意图："要 SVG text label，布局不依赖宿主 CSS/字体"。）
import { describe, expect, it } from "vitest";
import { mermaidInitOptions } from "./mermaid";

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
