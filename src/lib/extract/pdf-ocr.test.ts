// `pdf.ocr@1`（扫描件 / 混合文档）的行为判据。
//
// 为什么这些判据**不在共用夹具集里**：共用夹具是三台机器共用的口径，而"页图怎么交给视觉通道"
// 这一步的落点还没裁定（契约现在给裸 RGBA，视觉通道要编码图 —— 见
// `docs/plans/2026-09-17-knowledge-base-ai-coverage-plan.md` §15.8 与信箱
// `2026-09-17-pdf-ocr-rasterizer-gap.reply-9`）。**与形状无关**的行为（页选择、页码、上限、
// 失败传播、依赖缺失）在这里先钉住；裁定落地后，`fixtures.ts` 里补一条正向夹具，那一条会成为三轴共用口径。
//
// 形状已裁定（§15.8 第 1b 条：`rasterize` 直出**编码图**）⇒ 正向路径一律用**共享假 deps**
// （`testing/fakeDeps.ts` 的 `fakeRasterize` 产出合法 PNG、用生产同一个编码器；`fakeVision` 确定性返回）。
// 这里只保留一个**平台违约**用的假实现（裸 RGBA），钉"违约时不许把裸像素塞给 vision"。

import { describe, expect, it } from "vitest";

import { pdfPages } from "./fixtures";
import { depsOf, fakeRasterize, fakeVision } from "./testing/fakeDeps";
import { pdfOcrExtractor } from "./pdfOcr";
import type { ExtractDeps, ExtractInput, RasterizedPage } from "./types";

const MIME = "application/pdf";

function inputOf(bytes: Uint8Array, deps: ExtractDeps = {}): ExtractInput {
  return { bytes, filename: "扫描件.pdf", mime: MIME, hash: "h1", deps };
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

describe("pdf.ocr@1 · 页图交给视觉通道的形状（已裁定为**编码图**；这里钉的是违约防御）", () => {
  it("平台违约只给裸 RGBA ⇒ provider_error（**不许把裸像素塞给 vision**：适配器只能靠猜尺寸编码）", async () => {
    const raster = rgbaRasterize(1);
    const vision = fakeVision("不该被调用");
    // 这一条用的是**本地**的裸 RGBA 假实现（不是共享 `fakeRasterize`：后者按契约产出编码图）
    // ⇒ 直接组装 deps，不走 `depsOf()` 的共享形状。
    const r = await pdfOcrExtractor.extract(
      inputOf(scanPdf(), { rasterize: raster.fn, vision: vision.fn }),
    );
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
    const raster = fakeRasterize({ pages: 3 });
    const vision = fakeVision(() => "OCR 出来的那一页");
    const r = await pdfOcrExtractor.extract(inputOf(mixedPdf(), depsOf({ rasterize: raster, vision })));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.segments.map((s) => s.kind)).toEqual(["text", "ocr", "text"]);
    expect(r.segments.map((s) => s.loc)).toEqual(["p.1", "p.2", "p.3"]);
    expect(r.segments[1].text).toBe("OCR 出来的那一页");
  });

  it("**只对没有文本层的页做视觉**：三页里只有 p.2 是图 ⇒ 只渲染一次、只调一次模型（页码 0 基 = 1）", async () => {
    const raster = fakeRasterize({ pages: 3 });
    const vision = fakeVision("字");
    await pdfOcrExtractor.extract(inputOf(mixedPdf(), depsOf({ rasterize: raster, vision })));
    // 有文本层的页再烧一次 VLM 是**纯浪费**：混合文档里这是数量级差别
    expect(raster.calls.map((c) => c.pageIndex)).toEqual([1]);
    expect(raster.calls[0].scale).toBeGreaterThan(1); // 视觉要清晰度，不能按 1 倍（72dpi）渲染
    expect(vision.calls.length).toBe(1);
    expect(vision.calls[0].mime).toBe("image/png");
  });

  it("整篇都有文本层 ⇒ **一次视觉都不调**（走这条路说明调度器选错了候选，但结果不能错）", async () => {
    const raster = fakeRasterize({ pages: 1 });
    const vision = fakeVision("不该被调用");
    const r = await pdfOcrExtractor.extract(inputOf(textPdf(), depsOf({ rasterize: raster, vision })));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.segments.map((s) => s.kind)).toEqual(["text"]);
    expect(raster.calls).toEqual([]);
    expect(vision.calls).toEqual([]);
  });

  it("单页没认出字 ⇒ 那一页不出段，但**不**把整篇判成失败（整页是照片是正常的）", async () => {
    const raster = fakeRasterize({ pages: 3 });
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

  it("覆盖度：混合文档里 `pdf.ocr` 是**完整**覆盖（文字页给文本、扫描页给 OCR）⇒ 不传 coverage", async () => {
    const raster = fakeRasterize({ pages: 3 });
    const vision = fakeVision(() => "OCR 的字");
    const r = await pdfOcrExtractor.extract(inputOf(mixedPdf(), depsOf({ rasterize: raster, vision })));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 省略 coverage = 完整覆盖（契约口径）。这一条正是"混合文档不再静默丢页"的另一半：
    // 调度器看到它是完整的，就会整体替换掉 `pdf.text` 那份**有缺口**的结果。
    expect(r.coverage).toBeUndefined();
  });

  it("覆盖度：视觉对某一页没得到文字 ⇒ 记成缺口（覆盖度说的是「有没有内容」，不是「调用成没成功」）", async () => {
    const raster = fakeRasterize({ pages: 2 });
    let n = 0;
    const vision = fakeVision(() => (n++ === 0 ? "" : "第二页的字"));
    const r = await pdfOcrExtractor.extract(
      inputOf(pdfPages([{ text: "", graphics: true }, { text: "", graphics: true }]), {
        rasterize: raster.fn,
        vision: vision.fn,
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.segments.map((s) => s.loc)).toEqual(["p.2"]);
    expect(r.coverage?.complete).toBe(false);
    expect(r.coverage?.gapIndexes).toEqual([0]);
  });

  it("整篇都没得出文字 ⇒ empty（不是失败：抽取器认这种输入，只是没内容）", async () => {
    const raster = fakeRasterize({ pages: 1 });
    const vision = fakeVision("");
    const r = await pdfOcrExtractor.extract(inputOf(scanPdf(), depsOf({ rasterize: raster, vision })));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("empty");
  });
});

describe("pdf.ocr@1 · 失败传播：**不落半份**", () => {
  it("某一页光栅化失败 ⇒ provider_error 且带上页码（不是 internal、不是静默跳过那一页）", async () => {
    const raster = fakeRasterize({ pages: 3, rejectOn: [1] });
    const vision = fakeVision("字");
    const r = await pdfOcrExtractor.extract(inputOf(mixedPdf(), depsOf({ rasterize: raster, vision })));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("provider_error");
    expect(r.message).toContain("p.2");
  });

  it("视觉模型抛异常 ⇒ provider_error 且带上页码（异常必须转成错误码，不穿透）", async () => {
    const raster = fakeRasterize({ pages: 3 });
    const vision: NonNullable<ExtractDeps["vision"]> = async () => {
      throw new Error("连接模型超时");
    };
    // 手写的裸函数不是 `FakeVision` 形状 ⇒ 同样直接组装 deps
    const r = await pdfOcrExtractor.extract(inputOf(mixedPdf(), { rasterize: raster.fn, vision }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("provider_error");
    expect(r.message).toContain("p.2");
    expect(r.message).toContain("超时");
  });

  it("需要视觉的页超过上限 ⇒ **落已抽到的 + 用 coverage 标注缺口**（不再是整体失败）", async () => {
    const pages = 201; // MAX_OCR_PAGES = 200
    const raster = fakeRasterize({ pages });
    const vision = fakeVision(() => "字");
    const r = await pdfOcrExtractor.extract(
      inputOf(pdfPages(Array.from({ length: pages }, () => ({ text: "", graphics: true }))), {
        rasterize: raster.fn,
        vision: vision.fn,
      }),
    );
    // ⚠️ 立场变过一次，这条判据跟着变：上限原先直接红（"半份会被当成全文"）；
    //    契约补了 `ExtractCoverage` 之后，**标注出来的部分**比"什么都没有"更有用、也不会骗下游。
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.segments.length).toBe(200);
    expect(r.coverage?.complete).toBe(false);
    // 缺口如实列出（0 基）：第 201 页（序号 200）没做，其余没有缺口
    expect(r.coverage?.gapIndexes).toEqual([200]);
    expect(r.coverage?.note).toContain("上限");
    expect(vision.calls.length).toBe(200);
  });
});
