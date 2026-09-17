// `pdf.ocr@1`（扫描件 / 混合文档）的行为判据。
//
// 为什么这些判据**不在共用夹具集里**：共用夹具是三台机器共用的口径，而"页图怎么交给视觉通道"
// 这一步的落点还没裁定（契约现在给裸 RGBA，视觉通道要编码图 —— 见
// `docs/plans/2026-09-17-knowledge-base-ai-coverage-plan.md` §15.8 与信箱
// `2026-09-17-pdf-ocr-rasterizer-gap.reply-9`）。**与形状无关**的行为（页选择、页码、上限、
// 失败传播、依赖缺失）在这里先钉住；裁定落地后，`fixtures.ts` 里补一条正向夹具，那一条会成为三轴共用口径。
//
// ⚠️ 因此本文件里凡是标注「A 方案形状」的假光栅化，注入的是**待裁定**的形状
// （多带 `bytes` + `mime`）。它测的是**本抽取器的逻辑**（选哪些页、页码怎么给、失败怎么报），
// 换形状时只需要改这个假实现，不需要改断言。

import { describe, expect, it } from "vitest";

import { pdfPages } from "./fixtures";
import { pdfOcrExtractor } from "./pdfOcr";
import type { ExtractDeps, ExtractInput, RasterizedPage } from "./types";

const MIME = "application/pdf";

function inputOf(bytes: Uint8Array, deps: ExtractDeps = {}): ExtractInput {
  return { bytes, filename: "扫描件.pdf", mime: MIME, hash: "h1", deps };
}

/** 假光栅化：**A 方案形状**（返回编码图 + mime）。记录调用，便于断言"只渲染了空页"。 */
function encodedRasterize(opts: { pages: number; rejectOn?: readonly number[] } = { pages: 1 }) {
  const calls: { pageIndex: number; scale: number }[] = [];
  const fn: NonNullable<ExtractDeps["rasterize"]> = async (_bytes, pageIndex, scale) => {
    calls.push({ pageIndex, scale });
    if (opts.rejectOn?.includes(pageIndex) || pageIndex < 0 || pageIndex >= opts.pages) {
      throw new Error(`渲染第 ${pageIndex} 页失败`);
    }
    // 编码图：形状是待裁定的那一种（`bytes` + `mime`）；`rgba` 留着满足当前类型。
    const page = {
      rgba: new Uint8Array(0),
      width: 2,
      height: 2,
      bytes: new Uint8Array([pageIndex + 1, 0x89, 0x50]),
      mime: "image/png",
    };
    return page as unknown as RasterizedPage;
  };
  return { fn, calls };
}

/** 假光栅化：**裸 RGBA** —— 如今这是**平台违约**的形状。
 *
 *  契约已在 2026-09-17 裁定为「`rasterize` 只产出**编码图**」
 *  （`RasterizedPage = { bytes, mime, width, height }`，方案 §15.8 第 1b 条），
 *  裸 RGBA 已**不在类型允许的范围内**。这里保留它并用 cast，是为了继续验
 *  「**平台违约时不许把裸像素喂给 vision**」这条防御判据 —— 判据本身仍有价值。 */
function rgbaRasterize(pages = 1) {
  const calls: number[] = [];
  const fn: NonNullable<ExtractDeps["rasterize"]> = async (_bytes, pageIndex) => {
    calls.push(pageIndex);
    if (pageIndex >= pages) throw new Error("越界");
    return { rgba: new Uint8Array(16), width: 2, height: 2 } as unknown as RasterizedPage;
  };
  return { fn, calls };
}

function fakeVision(reply: string | ((prompt: string) => string)) {
  const calls: { prompt: string; byteLength: number; mime: string }[] = [];
  const fn: NonNullable<ExtractDeps["vision"]> = async (prompt, image, mime) => {
    calls.push({ prompt, byteLength: image.length, mime });
    return typeof reply === "function" ? reply(prompt) : reply;
  };
  return { fn, calls };
}

const scanPdf = () => pdfPages([{ text: "", graphics: true }]);
const mixedPdf = () =>
  pdfPages([{ text: "First" }, { text: "", graphics: true }, { text: "Third" }]);
const textPdf = () => pdfPages([{ text: "Only text" }]);

describe("pdf.ocr@1 · 依赖缺失（§15.3-7 的活样板）", () => {
  it("没有 rasterize ⇒ provider_error，并点名缺的是光栅化（抽取层不自己渲染）", async () => {
    const r = await pdfOcrExtractor.extract(inputOf(scanPdf(), { vision: fakeVision("x").fn }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("provider_error");
    expect(r.message).toContain("rasterize");
    expect(r.extractor).toBe("pdf.ocr@1");
  });

  it("没有 vision ⇒ provider_error，并点名缺的是视觉模型（抽取层不自己连网）", async () => {
    const r = await pdfOcrExtractor.extract(inputOf(scanPdf(), { rasterize: rgbaRasterize().fn }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("provider_error");
    expect(r.message).toContain("vision");
  });

  it("一个 deps 都不给（共用夹具那条）⇒ provider_error，绝不自建网络", async () => {
    const r = await pdfOcrExtractor.extract(inputOf(scanPdf()));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("provider_error");
  });

  it("不是 PDF 的字节 ⇒ unsupported（让调度器去换候选，而不是报 provider_error）", async () => {
    const deps = { rasterize: rgbaRasterize().fn, vision: fakeVision("x").fn };
    const r = await pdfOcrExtractor.extract(inputOf(new Uint8Array([1, 2, 3, 4]), deps));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("unsupported");
  });
});

describe("pdf.ocr@1 · 页图交给视觉通道的形状（**待裁定的契约缺口**）", () => {
  it("平台只给裸 RGBA ⇒ provider_error 并说明缺「RGBA → 编码图」这一步（**不猜形状、也不把裸像素塞给 vision**）", async () => {
    const raster = rgbaRasterize(1);
    const vision = fakeVision("不该被调用");
    const r = await pdfOcrExtractor.extract(inputOf(scanPdf(), { rasterize: raster.fn, vision: vision.fn }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("provider_error");
    expect(r.message).toContain("编码");
    // 关键：**没有**拿裸 RGBA 去调 vision（否则适配器只能靠猜尺寸编码）
    expect(vision.calls).toEqual([]);
    // 光栅化确实被调到（说明失败点在"交接"这一步，不是"没渲染"）
    expect(raster.calls).toEqual([0]);
  });
});

describe("pdf.ocr@1 · 页选择与页码（与形状无关的行为）", () => {
  it("混合文档：文字页出 `text`、扫描页出 `ocr`，页码**各自正确**、顺序与文档一致", async () => {
    const raster = encodedRasterize({ pages: 3 });
    const vision = fakeVision(() => "OCR 出来的那一页");
    const r = await pdfOcrExtractor.extract(inputOf(mixedPdf(), { rasterize: raster.fn, vision: vision.fn }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.segments.map((s) => s.kind)).toEqual(["text", "ocr", "text"]);
    expect(r.segments.map((s) => s.loc)).toEqual(["p.1", "p.2", "p.3"]);
    expect(r.segments[1].text).toBe("OCR 出来的那一页");
  });

  it("**只对没有文本层的页做视觉**：三页里只有 p.2 是图 ⇒ 只渲染一次、只调一次模型（页码 0 基 = 1）", async () => {
    const raster = encodedRasterize({ pages: 3 });
    const vision = fakeVision("字");
    await pdfOcrExtractor.extract(inputOf(mixedPdf(), { rasterize: raster.fn, vision: vision.fn }));
    // 有文本层的页再烧一次 VLM 是**纯浪费**：混合文档里这是数量级差别
    expect(raster.calls.map((c) => c.pageIndex)).toEqual([1]);
    expect(raster.calls[0].scale).toBeGreaterThan(1); // 视觉要清晰度，不能按 1 倍（72dpi）渲染
    expect(vision.calls.length).toBe(1);
    expect(vision.calls[0].mime).toBe("image/png");
  });

  it("整篇都有文本层 ⇒ **一次视觉都不调**（走这条路说明调度器选错了候选，但结果不能错）", async () => {
    const raster = encodedRasterize({ pages: 1 });
    const vision = fakeVision("不该被调用");
    const r = await pdfOcrExtractor.extract(inputOf(textPdf(), { rasterize: raster.fn, vision: vision.fn }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.segments.map((s) => s.kind)).toEqual(["text"]);
    expect(raster.calls).toEqual([]);
    expect(vision.calls).toEqual([]);
  });

  it("单页没认出字 ⇒ 那一页不出段，但**不**把整篇判成失败（整页是照片是正常的）", async () => {
    const raster = encodedRasterize({ pages: 3 });
    const vision = fakeVision(() => "字");
    const r = await pdfOcrExtractor.extract(
      inputOf(pdfPages([{ text: "", graphics: true }, { text: "X" }, { text: "", graphics: true }]), {
        rasterize: raster.fn,
        vision: vision.fn,
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.segments.map((s) => s.loc)).toEqual(["p.1", "p.2", "p.3"]);
  });

  it("整篇都没得出文字 ⇒ empty（不是失败：抽取器认这种输入，只是没内容）", async () => {
    const raster = encodedRasterize({ pages: 1 });
    const vision = fakeVision("");
    const r = await pdfOcrExtractor.extract(inputOf(scanPdf(), { rasterize: raster.fn, vision: vision.fn }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("empty");
  });
});

describe("pdf.ocr@1 · 失败传播：**不落半份**", () => {
  it("某一页光栅化失败 ⇒ provider_error 且带上页码（不是 internal、不是静默跳过那一页）", async () => {
    const raster = encodedRasterize({ pages: 3, rejectOn: [1] });
    const vision = fakeVision("字");
    const r = await pdfOcrExtractor.extract(inputOf(mixedPdf(), { rasterize: raster.fn, vision: vision.fn }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("provider_error");
    expect(r.message).toContain("p.2");
  });

  it("视觉模型抛异常 ⇒ provider_error 且带上页码（异常必须转成错误码，不穿透）", async () => {
    const raster = encodedRasterize({ pages: 3 });
    const vision: NonNullable<ExtractDeps["vision"]> = async () => {
      throw new Error("连接模型超时");
    };
    const r = await pdfOcrExtractor.extract(inputOf(mixedPdf(), { rasterize: raster.fn, vision }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("provider_error");
    expect(r.message).toContain("p.2");
    expect(r.message).toContain("超时");
  });

  it("需要视觉的页超过上限 ⇒ provider_error 说明上限（**不返回抽到一半的结果**：半份会被当完整内容落库）", async () => {
    const pages = 201; // MAX_OCR_PAGES = 200
    const raster = encodedRasterize({ pages });
    const vision = fakeVision("字");
    const r = await pdfOcrExtractor.extract(
      inputOf(pdfPages(Array.from({ length: pages }, () => ({ text: "", graphics: true }))), {
        rasterize: raster.fn,
        vision: vision.fn,
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("provider_error");
    expect(r.message).toContain("200");
    expect(r.message).toContain("p.201");
  });
});
