// `inlineMd`：把后端文案里的行内 `**强调**` 渲染成 <b>，**绝不吞字**。
//
// 为什么值得单独钉：它是"用户看不见两个星号"这件事的**唯一一处实现**（toast 与空间隐私面板共用）。
// 最坏的错误不是"没加粗"，而是**把字吃掉**（split 型实现很容易在落单星号上丢内容）——
// 所以下面的负例与正例一样重要。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { inlineMd } from "./inlineMd";

/** 渲染成 HTML 字符串（比对标签与文本都一目了然）。 */
const html = (s: string) => renderToStaticMarkup(createElement("span", null, inlineMd(s)));

describe("inlineMd（行内 **强调** → <b>）", () => {
  it("① 成对的标记 ⇒ <b>，且文字一字不少", () => {
    expect(html("空间是**明文**，先加密")).toBe("<span>空间是<b>明文</b>，先加密</span>");
    // 多段
    expect(html("**甲**和**乙**")).toBe("<span><b>甲</b>和<b>乙</b></span>");
  });

  it("② ★ 落单的星号 ⇒ **原样保留**（不吞字、不把半句话加粗）", () => {
    expect(html("只有**一半")).toBe("<span>只有**一半</span>");
    expect(html("**开头没结尾")).toBe("<span>**开头没结尾</span>");
    // 前一对成对、后面落单 ⇒ 前面的照样加粗，后面的星号留在文本里
    expect(html("**对**，然后**落单")).toBe("<span><b>对</b>，然后**落单</span>");
  });

  it("③ 没有星号 / 空串 ⇒ 原样（不做任何事）", () => {
    expect(html("普通一句话")).toBe("<span>普通一句话</span>");
    expect(html("")).toBe("<span></span>");
  });

  it("④ 组内不跨 `*`（保守）：`**a** 与 **b**` 不会被读成一大段", () => {
    const out = html("**a** 与 **b**");
    expect(out).toBe("<span><b>a</b> 与 <b>b</b></span>");
  });
});
