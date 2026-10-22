// 判据：阅读屏的**图片块**必须真的画出那张图（有 `src` 时），没有 `src` 才退成占位框。
//
// 来由（owner 2026-10-22 手机实拍）：「web 版移动端的快速录入页面图片保存显示有问题吧？」
//   两层原因叠在一起：
//   ① 契约里**没有 `src`** ⇒ 阅读屏只能画占位框（`mobileReadBlocks` 那笔的偷懒）；
//   ② web 的 `save_image` 返回的是**一次性 `blob:` URL**（`web.ts` 的 `blobUrl(bytes,mime)`），
//      存进正文后刷新/换设备就是死链 —— 这一条**本测试管不到**（它需要一条 hash→URL 的解析通道），
//      在 `docs/known-issues.md` 有记录前先如实写在这里，别让"绿了"看起来像"图片持久化了"。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BlockView } from "./MobileRead";
import type { PageBlock } from "../types";

const mk = (over: Partial<PageBlock>): PageBlock => ({
  block_id: "b1",
  kind: "image",
  text: "",
  items: [],
  src: "",
  ...over,
});

describe("移动阅读屏 · 图片块", () => {
  it("① 有 src ⇒ 输出 <img>，且 src 原样进去", () => {
    const html = renderToStaticMarkup(<BlockView b={mk({ src: "blob:http://x/abc" })} />);
    expect(html).toContain("<img");
    expect(html).toContain('src="blob:http://x/abc"');
    expect(html).toContain("mread-img-el");
  });

  it("② 没有 src ⇒ 退成占位框（如实说「这里有一张图」，不是碎图）", () => {
    const html = renderToStaticMarkup(<BlockView b={mk({ src: "" })} />);
    expect(html).toContain("mread-img");
    expect(html).not.toContain("<img");
  });

  it("③ 契约里必须有 src 这一格（Rust + TS 两侧同口径）", () => {
    const ts = readFileSync(resolve(__dirname, "../lib/platform/pageBlocks.ts"), "utf8");
    expect(ts, "TS 侧提取没带 src").toMatch(/src: typeof c\?\.src === "string"/);
    const rs = readFileSync(resolve(__dirname, "../../src-tauri/src/doc_content.rs"), "utf8");
    expect(rs, "Rust 侧 DocBlock 没带 src").toMatch(/pub src: String/);
  });
});
