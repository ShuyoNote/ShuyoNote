// `pdf.text@1` 的单元判据。
//
// 夹具（`conformance.test.ts`）钉的是"三份实现看到同一组期望"，这里钉的是**这个实现自己的坑**：
// 最要紧的一条是 **pdf.js 会接管（transfer）传进去的 buffer** —— 同一个 `Uint8Array` 抽第二次会炸。
// 本仓 2026-09-15 在渲染路径上真踩过（报 "The object can not be cloned."，且只在 React StrictMode
// 的第二次加载时出现，非常难查）。抽取器里已经先复制一份规避，这条判据就是防止有人"顺手优化掉"那次复制。

import { describe, expect, it } from "vitest";

import { pdfOf, pdfPages } from "./fixtures";
import { pdfTextExtractor } from "./pdf";

const input = (bytes: Uint8Array) => ({
  bytes,
  filename: "制度.pdf",
  mime: "application/pdf",
  hash: "a".repeat(64),
  deps: {},
});

describe("pdf.text@1", () => {
  it("同一份字节**连抽两次**都要成功（pdf.js transfer buffer 的回归）", async () => {
    const bytes = pdfOf("Chapter One");
    const first = await pdfTextExtractor.extract(input(bytes));
    expect(first.ok, "第一次就该成功").toBe(true);
    // 关键：第二次用的是**同一个 Uint8Array 对象**。若抽取器把 bytes 直接交给 pdf.js，
    // 这里会拿到 internal 错误（"The object can not be cloned."）。
    const second = await pdfTextExtractor.extract(input(bytes));
    expect(second.ok, "第二次也必须成功——说明抽取器交给了 pdf.js 一份副本").toBe(true);
    expect(bytes.byteLength, "原始 Uint8Array 不应被 detach（byteLength 变 0 就是被 transfer 了）").toBeGreaterThan(0);
  });

  it("覆盖度：全部页都有文本层 ⇒ 完整覆盖（**不传** coverage，与「省略即完整」的契约一致）", async () => {
    const r = await pdfTextExtractor.extract(input(pdfPages([{ text: "First" }, { text: "Second" }])));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.coverage).toBeUndefined();
  });

  it("覆盖度：有页没有文本层 ⇒ complete:false 且缺口是**那几页**（0 基）—— 混合文档不再静默丢页", async () => {
    // 这条是"混合文档（正文是文字、中间夹扫描页）"能被调度器接手的前提：
    // 报出缺口 ⇒ `pipeline` 才会再试 `pdf.ocr`，并按"谁缺口少用谁"整体替换。
    const r = await pdfTextExtractor.extract(
      input(pdfPages([{ text: "First" }, { text: "", graphics: true }, { text: "Third" }])),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.segments.map((s) => s.loc)).toEqual(["p.1", "p.3"]);
    expect(r.coverage?.complete).toBe(false);
    expect(r.coverage?.gapIndexes).toEqual([1]); // 0 基：第 2 页
    expect(r.coverage?.note).toContain("没有文本层");
  });

  it("不是 PDF ⇒ unsupported（换抽取器），不是 corrupt（别吓人）", async () => {
    const r = await pdfTextExtractor.extract(input(new TextEncoder().encode("hello, not a pdf")));
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.code).toBe("unsupported");
  });

  it("没有文本层 ⇒ empty（扫件），loc 与 kind 都不该出现", async () => {
    const r = await pdfTextExtractor.extract(input(pdfOf("", { withText: false })));
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.code).toBe("empty");
  });

  it("有文本层 ⇒ 一页一段、loc 从 p.1 起、kind=text", async () => {
    const r = await pdfTextExtractor.extract(input(pdfOf("Chapter One of the Rules")));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.extractor).toBe("pdf.text@1");
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0].kind).toBe("text");
    expect(r.segments[0].loc).toBe("p.1");
    expect(r.segments[0].text).toContain("Chapter One");
  });
});
