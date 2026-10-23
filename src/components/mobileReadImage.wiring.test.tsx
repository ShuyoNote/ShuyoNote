// 判据：阅读屏的**图片块**必须真的画出那张图；`src` 为空或解析不到才退成占位框。
//
// 来由（owner 2026-10-22）：「web 版移动端的快速录入页面图片保存显示有问题吧？」
//   ① 契约里**没有 `src`** ⇒ 阅读屏只能画占位框（`mobileReadBlocks` 那笔的偷懒）；
//   ② web 的 `save_image` 当时返回**一次性 `blob:` URL** ⇒ 刷新即死（2026-10-23 改成
//      `asst:<hash>` 稳定引用，渲染时现取 —— 见 `lib/assetRef.ts`）。
//   ② 的源码级判据在 `src/lib/assetRef.wiring.test.ts`；本文件管 ① 与渲染分支。
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
  // ⚠️ 2026-10-23 起渲染是**两步**：先拿 `b.src` 去 `platform.asset.resolveRef` 解析，
  //   解析出地址才画 <img>（web 那份引用必须现取 object URL —— 见 lib/assetRef.ts）。
  //   所以 SSR 的首帧**必然是占位框**（effect 没跑）—— 那是"加载中"，不是"没有图"。
  it("① 首帧（解析未完成）画占位框；解析完成后才画 <img>（源码判据）", () => {
    const html = renderToStaticMarkup(<BlockView b={mk({ src: "asst:abc123" })} />);
    expect(html, "首帧应当是占位框（异步解析还没回来）").toContain("mread-img");
    expect(html).not.toContain("<img");
    const src = readFileSync(resolve(__dirname, "MobileRead.tsx"), "utf8");
    expect(src, "必须走平台 resolveRef（web 现造 object URL ／ 桌面原样返回）").toMatch(
      /platform\.asset\.resolveRef\(b\.src\)/,
    );
    expect(src, "<img> 必须吃解析后的地址，而不是原始 b.src").toMatch(/src=\{imgSrc\}/);
  });

  it("② 没有 src ⇒ 占位框（如实说「这里有一张图」，不是碎图）", () => {
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
