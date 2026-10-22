// 判据：移动阅读屏**按块类型**渲染（不是把所有块排成一样的 `<p>`）。
//
// 来由（owner 2026-10-22 截图）：「web 的移动版页面样式没有了？」
//   实测：种子页 `content_json` 里明明有 `h1/h2/callout/quote/list/image`，
//   而 04 阅读屏把它们**全渲染成普通段落** —— 根因不在 CSS，在**契约**：
//   `get_page_blocks` 只给 `{block_id, text}`，前端根本不知道"这块是什么"。
//   ⇒ 契约补了 `kind` / `items`（Rust `doc_content::DocBlock` ＋ TS `pageBlocksFromDoc` 同口径），
//     这条钉住"组件真的用上了它们"，以及"认不出来的类型不许丢"。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(resolve(__dirname, "MobileRead.tsx"), "utf8");
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const blockView = code.slice(code.indexOf("function BlockView"));

describe("移动阅读屏 · 按块类型渲染", () => {
  it("① 正文走 BlockView（⛔ 不再把所有块拍成同一个 <p>）", () => {
    // ⚠️ 只断言 **BlockView 之外**的主组件，别把 BlockView 那个**合法的** default 分支也算成违规
    const main = code.slice(0, code.indexOf("function BlockView"));
    expect(main, "正文应当渲染 <BlockView>").toMatch(/<BlockView\b/);
    expect(main, '主组件里又回到「一律 mread-p」的老写法了').not.toMatch(/className="mread-p"/);
  });

  it("② 六种块各有自己的元素/类名（标题分级、列表、引用、callout、图片、分隔线）", () => {
    for (const [kind, cls] of [
      ["h1", "mread-h1"],
      ["h2", "mread-h2"],
      ["h3", "mread-h3"],
      ["list", "mread-list"],
      ["quote", "mread-quote"],
      ["callout", "mread-callout"],
      ["image", "mread-img"],
    ]) {
      expect(blockView, `kind=${kind} 没有对应的 ${cls}`).toContain(`case "${kind}"`);
      expect(blockView, `kind=${kind} 没挂 ${cls}`).toContain(cls);
    }
  });

  it("③ 列表用 items（逐项），不拿 text 去切", () => {
    expect(blockView, "列表应当遍历 b.items").toMatch(/b\.items/);
  });

  it("④ 认不出来的 kind 必须兜到普通段落（⛔ 不许丢块）", () => {
    expect(blockView, "缺 default 兜底").toMatch(/default:\s*return <p className="mread-p">/);
  });
});
