// PDF 文本层抽取器 —— 家族「PDF + 扫描件」，见 docs/plans/2026-09-17-knowledge-base-ai-coverage-plan.md §15。
//
// 职责边界（契约冻结 v1）：
//   · 只做「PDF → 带页码定位的文本段」，**不渲染、不出网、不分块**（分块是 P2）；
//   · 扫描件（没有文本层）**不是失败**：返回 `empty`，让调度器按候选列表自然落到 `pdf.ocr`（§15.4）。
//
// 两个实测坑写在这里，免得下一个人重踩：
//   ① **pdf.js 会接管（transfer）传进去的 buffer** ⇒ 同一个 `Uint8Array` 抽第二次会报
//      "The object can not be cloned."（本仓 2026-09-15 在渲染路径上真踩过）。所以这里**先复制一份**
//      再交给 pdf.js，并且有一条"同一份字节抽两次都要成功"的判据盯着它。
//   ② **workerSrc 必须设**，否则 Node/vitest 下 `Setting up fake worker failed`。
//      浏览器侧与 `pdfjsEngine.ts` 同一套（垫片 → 真 worker）；非 DOM 环境直接指 pdf.js 自带的 worker。
//      这里**刻意重复**引擎那三行而不 import 引擎：引擎会拉进 canvas 渲染那一套，
//      而文本层抽取既不需要渲染，也不该让测试被渲染依赖拖住。
//
// ⚠️ 页读取那一层（`readPdfPages`）是**与 `pdf.ocr` 共用**的：`pdf.ocr` 必须知道"哪些页没有文本层"
//    （只对空页做视觉，有文本层的页不再烧一次 VLM）。两处各写一份页循环，必然会出现
//    "一个按 hasEOL 断行、另一个直接 join"这种分歧，而这层分歧没有任何编译期信号。

import * as pdfjs from "pdfjs-dist";

import { ensurePdfjsWorkerSrc } from "../pdfEngine/pdfjsWorker";

import {
  fail,
  ok,
  type ExtractCoverage,
  type ExtractInput,
  type ExtractResult,
  type ExtractedSegment,
  type Extractor,
} from "./types";

const ID = "pdf.text@1";

/** 防御性上限：畸形 PDF 声称有百万页时，不要在这里把进程拖死。
 *  ⚠️ 超出的页**不抽、且当前契约里没有地方标注"被截断了"**（段是内容，不是元数据）——
 *  这是一条已知的覆盖缺口，与 `pdf.ocr` 的页数上限同源，已提给契约所有者（见 §15.13 待评）。
 *  2000 页这个值取"正常文档够不到"，所以实际后果可忽略；`pdf.ocr` 的上限小得多（视觉调用要钱）。 */
export const MAX_PAGES = 2000;

/** pdf.js 的 worker 配置抽到了 src/lib/pdfEngine/pdfjsWorker.ts（三个调用方共一处，含"垫片/真 worker/测试"
 *  三种情形的判断与版本号缓存失效）——这里只调用它，避免第三份副本。 */
function ensurePdfjsWorker(): void {
  ensurePdfjsWorkerSrc(pdfjs);
}

/** 一页的文本项 → 纯文本。**保留换行、压掉行内多余空白**：CJK 里逐字拼接会被空格切开，
 *  所以按 pdf.js 给的 `hasEOL` 断行，而不是简单 join(" ")。 */
export function joinPageText(items: ReadonlyArray<{ str?: string; hasEOL?: boolean }>): string {
  let raw = "";
  for (const it of items) {
    raw += it.str ?? "";
    if (it.hasEOL) raw += "\n";
  }
  return raw
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

/** 把 pdf.js 的异常映射成契约里的错误码（抽取器不抛异常，§15.3）。
 *  `id` 由调用方给：`pdf.text@1` 与 `pdf.ocr@1` 共用这套分类，各自的失败要挂在自己的 id 上。 */
export function classifyPdfError(id: string, err: unknown): ExtractResult {
  const name = (err as { name?: string } | null)?.name ?? "";
  const message = String((err as { message?: string } | null)?.message ?? err);
  if (name === "PasswordException") return fail(id, "encrypted", "PDF 有口令保护，抽不了文本层");
  if (name === "InvalidPDFException" || /Invalid PDF|xref|trailer/i.test(message)) {
    return fail(id, "corrupt", `PDF 结构损坏：${message}`);
  }
  return fail(id, "internal", `pdf.js 报错（${name || "unknown"}）：${message}`);
}

/** 开头是不是 PDF 的魔数（`pdf.text` 与 `pdf.ocr` 共用同一条判据）。 */
export function looksLikePdf(bytes: Uint8Array): boolean {
  return new TextDecoder("latin1").decode(bytes.subarray(0, 1024)).includes("%PDF-");
}

export interface PdfPage {
  /** 1 基页码（与 `loc` 的 `p.<n>` 同一口径）。 */
  page: number;
  text: string;
}

export interface PdfPageRead {
  /** 文档声明的总页数（可能大于实际读到的页数）。 */
  totalPages: number;
  /** 实际读到的页（按页码升序）。 */
  pages: readonly PdfPage[];
  /** **没有文本层的页号**（1 基）——`pdf.ocr` 就靠它决定"哪几页要做视觉"。 */
  emptyPages: readonly number[];
}

/** 读取结果：要么拿到页，要么拿到一个已经归好类的失败结果（抽取器不抛异常）。 */
export type PdfRead = { ok: true; value: PdfPageRead } | { ok: false; result: ExtractResult };

/**
 * 逐页读文本层（**共用入口**）：返回每页文本 + 空页清单。
 *
 * 失败**不抛**，返回 `{ ok: false, result }`，其中的 `result` 已经把 pdf.js 的异常归成契约错误码。
 * 不在这里判 `empty`：那是**抽取器**的口径（`pdf.text` 全空 ⇒ `empty`；`pdf.ocr` 全空但仍可能出图）。
 */
export async function readPdfPages(
  id: string,
  bytes: Uint8Array,
  maxPages: number = MAX_PAGES,
): Promise<PdfRead> {
  ensurePdfjsWorker();

  let doc: Awaited<ReturnType<typeof pdfjs.getDocument>["promise"]>;
  try {
    doc = await pdfjs.getDocument({
      // ⚠️ 必须是**副本**：pdf.js 会接管这份 buffer（见文件头坑 ①）。
      data: new Uint8Array(bytes),
      useWorkerFetch: false,
      isEvalSupported: false,
    }).promise;
  } catch (err) {
    return { ok: false, result: classifyPdfError(id, err) };
  }

  const totalPages = doc.numPages;
  const pages: PdfPage[] = [];
  const emptyPages: number[] = [];
  try {
    const count = Math.min(totalPages, maxPages);
    for (let n = 1; n <= count; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const text = joinPageText(content.items as ReadonlyArray<{ str?: string; hasEOL?: boolean }>);
      pages.push({ page: n, text });
      if (text.length === 0) emptyPages.push(n);
    }
  } catch (err) {
    return { ok: false, result: classifyPdfError(id, err) };
  } finally {
    // 释放 worker 侧的文档：抽取可能连着跑成百上千个文件，别把内存攒住。
    await doc.destroy().catch(() => {});
  }

  return { ok: true, value: { totalPages, pages, emptyPages } };
}

/** 页读取结果 → 覆盖度（`null` = 完整覆盖，此时**不传** `coverage`，与"省略即完整"的契约一致）。
 *
 *  两类缺口都要报：① **没有文本层的页**（混合文档里的扫描插页）；② **被上限截断的页**。
 *  `gapIndexes` 是 **0 基**（契约规定），而页码是 1 基 —— 只在这一处转换。 */
function coverageOf(read: PdfPageRead): ExtractCoverage | null {
  const readPages = read.pages.length;
  const truncated = read.totalPages > readPages;
  const gaps = read.emptyPages.map((n) => n - 1);
  if (truncated) {
    for (let i = readPages; i < read.totalPages; i++) gaps.push(i);
  }
  if (gaps.length === 0) return null;

  const parts: string[] = [];
  if (read.emptyPages.length > 0) parts.push(`${read.emptyPages.length} 页没有文本层`);
  if (truncated) parts.push(`超过单次上限 ${MAX_PAGES} 页，只读到 p.${readPages}（源 ${read.totalPages} 页）`);
  return {
    complete: false,
    gapIndexes: gaps,
    note: parts.join("；"),
  };
}

export const pdfTextExtractor: Extractor = {
  id: ID,
  mimes: ["application/pdf"],
  extensions: [".pdf"],
  cost: "cpu",

  async extract(input: ExtractInput): Promise<ExtractResult> {
    if (!looksLikePdf(input.bytes)) return fail(ID, "unsupported", "不是 PDF：开头 1 KiB 里找不到 %PDF-");

    const read = await readPdfPages(ID, input.bytes);
    if (!read.ok) return read.result;

    const segments: ExtractedSegment[] = read.value.pages
      .filter((p) => p.text.length > 0)
      .map((p) => ({ kind: "text", text: p.text, loc: `p.${p.page}` }));

    if (segments.length === 0) {
      // 扫描件走这条路：**不是失败**，是"这个抽取器没内容可给"，交给 pdf.ocr。
      return fail(ID, "empty", `PDF 共 ${read.value.totalPages} 页，但没有文本层（扫描件？交给 pdf.ocr）`);
    }
    // **覆盖度**（契约 2026-09-17 增补）：`ok` 不等于"抽全了"。
    // 本文档跳过空页 ⇒ 报 `complete: false` + 缺口页号，调度器据此**再试下一个候选**
    //（`pdf.ocr`），并按"谁缺口少用谁"替换 —— 这才是混合文档（正文是文字、中间夹扫描页）
    // 不再静默丢页的那条路。不报覆盖度，`pipeline` 会以为抽完了，那几页就永远没有内容。
    const coverage = coverageOf(read.value);
    return coverage ? ok(ID, segments, coverage) : ok(ID, segments);
  },
};
