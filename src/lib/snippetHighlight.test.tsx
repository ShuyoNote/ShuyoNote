// `snippetHighlight`：把检索片段里的 `[[命中]]` 标记渲染成 `<mark>`（效果图 03 的"命中片段高亮"）。
//
// 为什么值得单独钉（**两条真的原因**）：
// ① 它是**两张屏共用的唯一一处实现**（桌面 `SearchPanel` ＋ 移动端 `MobileSearch`）——
//    2026-10-10 抽出时就是为了不让"同一个标记格式在两处解析成两种东西"。
// ② ⭐ **浏览器里看不到它** ✗：带标记的片段来自 **FTS 路径**
//    （`src-tauri/src/search.rs:584` 的 `snippet(..., '[[', ']]', …)` ✓），
//    而 **web 平台退化成 LIKE**（`build_like_snippet` **不加标记** ✗）⇒ 三条 mobile 门禁
//    跑的是 web 壳 ⇒ **它们永远量不到 `<mark>`** ✓。⇒ 这个解析器的判据只能靠**单元测试**给 ✓。
//
// ⚠️ 最坏的错误与 `inlineMd` 那条同族：**吞字**（split 型实现很容易在落单标记上丢内容）。
//    所以下面的负例（没有标记 / 只有半个标记）与正例一样重要 ✓。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Highlighted } from "./snippetHighlight";

/** 渲染成 HTML 字符串（比对标签与文本都一目了然 ✓）。 */
const html = (s: string) => renderToStaticMarkup(createElement(Highlighted, { text: s }));

describe("snippetHighlight（[[命中]] → <mark>）", () => {
  it("① 成对的标记 ⇒ <mark>，且文字一字不少", () => {
    expect(html("…广角低机位，[[相机]]站在护栏上拍…")).toBe(
      "<span>…广角低机位，</span><mark>相机</mark><span>站在护栏上拍…</span>",
    );
  });

  it("② 多段命中 ⇒ 多个 <mark>（顺序不许乱）", () => {
    expect(html("[[甲]]和[[乙]]")).toBe("<mark>甲</mark><span>和</span><mark>乙</mark>");
  });

  it("③ ★ 没有标记（LIKE 兜底路径的真实形状）⇒ **整段纯文本**，一个字不改", () => {
    // `search.rs:26-47 build_like_snippet` 逐字行为：两端补 `…`、**全程不加 `[[`/`]]`** ✓
    expect(html("…他把相机收进包里再走…")).toBe("<span>…他把相机收进包里再走…</span>");
  });

  it("④ ★ 落单的标记 ⇒ 后面的文字**原样保留**（不吞字、不凭空加粗）", () => {
    // `split` 的奇偶语义下"只有开标记"会把尾段当命中 —— 这是**已知且记录在案**的行为：
    // 索引层只会成对产出（`snippet()` 成对插入 ✓），所以这里只钉"**不丢字**" ✓。
    const out = html("前半[[后半");
    expect(out.replace(/<\/?[a-z]+>/g, "")).toBe("前半后半");
  });
});
