// 判据（task-30 的 TS 那半步）：**盖页码** ＋ ⭐ **"引擎页头页脚有没有回来"的结果级检测**。
//
// ⭐ 为什么是**结果级**（⛔ 不写源码级 ✗）：页头页脚**不在我们的 HTML 里** —— 它们由**打印引擎**渲染
//   （`print.ts:51-78` 只有隐藏 iframe ＋ `win.print()` ✓；`print.ts` 里 `@page|headerTemplate|footer`
//   **零命中** ✓）⇒ 拿源码去查"有没有页头页脚"必然是**空 ⇒ 假绿** ✗。
//   ⇒ 所以判据走**抽 PDF 文本**：`pdfjs-dist` 把这个 PDF 的文字读出来，再断言三样东西在不在 ✓。
//
// ⭐ **怎么看出它会红**（逐条）：
//   · 把 Rust 那半步的 `ShouldPrintHeaderAndFooter=false` 改回 true（或删掉）⇒ 引擎把**日期／标题／URL**
//     重新画进 PDF ⇒ `looksLikeEngineHeaderFooter(每页文本)` 变 **true** ⇒ **本文件第 2 条红** ✓
//   · 把 `stampPageNumbers` 里那个 `pages.forEach` 删掉/注释掉 ⇒ 每页文本里**没有页码** ⇒ **第 1 条红** ✓
//   · 把盖章改成 `addPage` 而不是在已有页上画 ⇒ **页数变了** ⇒ **第 1 条红** ✓
//   ⚠️ 而第 3 条是**正向对照**：它专门喂一个"**带**引擎那三样"的夹具，断言检测函数**必须返回 true** ✓
//      ⇒ 它保证"第 2 条不会是永远绿的假判据" ✓（⭐ 一条判据如果**永远**绿，它没在验任何东西 ✓）
//
// ⚠️ 还没验的那一段（⛔ 不假装验过 ✗）：**真 PDF 得由 Rust 那半步产出** ⇒ 它一到，就用**同一个**
//   `looksLikeEngineHeaderFooter` 断言"那份真产物里没有那三样" ✓（本轮我只验"盖章"与"检测器"两件 ✓）。

import { PDFDocument, StandardFonts } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, it } from "vitest";

import {
  defaultPageNumberText,
  looksLikeEngineHeaderFooter,
  stampPageNumbers,
} from "./pdfPageNumbers";

/** 造一个 N 页的 PDF：每页写一行正文（正文**不含** URL／日期 ⇒ 判据不会假红 ✓）。 */
async function makePdf(pageTexts: string[], opts: { engineMarks?: boolean } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  pageTexts.forEach((text, i) => {
    const page = doc.addPage([300, 300]);
    page.drawText(text, { x: 20, y: 150, size: 11, font });
    if (opts.engineMarks) {
      // ⭐ 正向对照用的"引擎味道"：日期 ＋ URL（就是引擎默认页眉/页脚那两样 ✓）
      page.drawText("2026-10-10", { x: 20, y: 285, size: 8, font });
      page.drawText(`https://example.com/note/${i + 1}`, { x: 20, y: 12, size: 8, font });
    }
  });
  return (await doc.save()) as Uint8Array<ArrayBuffer>;
}

/** 抽每页文本（⭐ 传**副本**：pdf.js 会 transfer 掉传进去的 buffer —— 仓里 `check-pdf-reload.mjs:4` 记过这坑 ✓）。 */
async function extractText(pdf: Uint8Array): Promise<string[]> {
  const doc = await getDocument({ data: new Uint8Array(pdf) }).promise;
  const out: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    out.push(content.items.map((it) => ("str" in it ? it.str : "")).join(""));
  }
  await doc.destroy();
  return out;
}

describe("task-30 · 导出 PDF 的页码（TS 那半步）", () => {
  it("1) 盖页码：**页数不变** ＋ **每页都出现它自己的页码** ＋ 原正文还在", async () => {
    const src = await makePdf(["alpha", "bravo", "charlie"]);
    const stamped = await stampPageNumbers(src);
    const pages = await extractText(stamped);

    expect(pages.length, "⛔ 页数不许变（盖章只能在已有页上画 ✓）").toBe(3);
    expect(pages[0], "第 1 页没有页码").toContain(defaultPageNumberText(1, 3));
    expect(pages[1], "第 2 页没有页码").toContain(defaultPageNumberText(2, 3));
    expect(pages[2], "第 3 页没有页码").toContain(defaultPageNumberText(3, 3));
    // ⭐ 原正文不许被盖掉/丢掉 ✓
    expect(pages[0]).toContain("alpha");
    expect(pages[1]).toContain("bravo");
    expect(pages[2]).toContain("charlie");
  });

  it("2) ⭐ 结果级：**没有页头页脚内容**（日期/标题/URL）＋ **有页码** —— 这就是要交给 Rust 产物的那条判据", async () => {
    // 模拟"引擎出 PDF 时已经关掉了页头页脚"（⇐ Windows 新路的前提 ✓）
    const clean = await makePdf(["alpha", "bravo"], { engineMarks: false });
    const stamped = await stampPageNumbers(clean);
    const pages = await extractText(stamped);

    for (const [i, text] of pages.entries()) {
      expect(
        looksLikeEngineHeaderFooter(text, { title: "我的笔记" }),
        `第 ${i + 1} 页出现了页头页脚的味道（日期/标题/URL）`,
      ).toBe(false);
      expect(text, `第 ${i + 1} 页没有页码`).toContain(defaultPageNumberText(i + 1, pages.length));
    }
  });

  it("3) ⭐ 正向对照：喂一个**带**引擎那三样的 PDF ⇒ 检测函数**必须**返回 true（否则第 2 条是永远绿的假判据）", async () => {
    const marked = await makePdf(["alpha"], { engineMarks: true });
    const pages = await extractText(marked);
    expect(pages[0], "夹具里应当有 URL").toContain("https://example.com");
    expect(looksLikeEngineHeaderFooter(pages[0]), "URL 那一支没认出来").toBe(true);
    expect(looksLikeEngineHeaderFooter("2026-10-10"), "日期那一支没认出来").toBe(true);
    expect(looksLikeEngineHeaderFooter("我的笔记 正文", { title: "我的笔记" }), "标题那一支没认出来").toBe(true);
    // ⭐ 而"干净文本"必须为 false（⛔ 不许永远返回 true ✗ —— 那也会让第 2 条失去意义 ✓）
    expect(looksLikeEngineHeaderFooter("正文而已，没有那三样")).toBe(false);
    expect(looksLikeEngineHeaderFooter(defaultPageNumberText(1, 3))).toBe(false);
  });

  it("4) 格式可换 ＋ 单页也对 ＋ 入参不被改", async () => {
    const src = await makePdf(["only"]);
    const stamped = await stampPageNumbers(src, { format: (p, t) => `Page ${p} of ${t}` });
    const pages = await extractText(stamped);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toContain("Page 1 of 1");
    // ⭐ 入参没被改（pdf-lib 是"载入 ⇒ 另存"⇒ 原字节仍能解析出原来的页数 ✓）
    const reloaded = await PDFDocument.load(src);
    expect(reloaded.getPageCount(), "⛔ 不许改入参").toBe(1);
  });
});
