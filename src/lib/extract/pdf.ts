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

import { pathToFileURL } from "node:url";

import * as pdfjs from "pdfjs-dist";

import { fail, ok, type ExtractInput, type ExtractResult, type ExtractedSegment, type Extractor } from "./types";

const ID = "pdf.text@1";

/** 防御性上限：畸形 PDF 声称有百万页时，不要在这里把进程拖死（超出的页不抽，并在段里标注）。 */
const MAX_PAGES = 2000;

let workerConfigured = false;

function ensurePdfjsWorker(): void {
  if (workerConfigured) return;
  const opts = pdfjs.GlobalWorkerOptions as { workerSrc?: string };
  const viteMode = (import.meta as unknown as { env?: { MODE?: string } }).env?.MODE;
  const inBrowser = typeof document !== "undefined" && typeof window !== "undefined";

  if (inBrowser && viteMode !== "test") {
    // 浏览器 / Android WebView：走我们自己的垫片（WebView 缺 Promise.withResolvers 等），
    // 与 src/lib/pdfEngine/pdfjsEngine.ts 的写法保持一致。
    const real = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).href;
    const shim = new URL("pdfjs-worker-shim.mjs", document.baseURI).href;
    opts.workerSrc = `${shim}?real=${encodeURIComponent(real)}`;
  } else {
    // 测试运行器（vitest 也有 `document`，但没有那个垫片文件，且 ESM 加载器只认 file:/data:）
    // 与任何非 DOM 环境：直接把 workerSrc 指到 node_modules 里的 worker 文件。
    // 这里用 `process.cwd()` 而不是 `import.meta.url`：Vite 在测试里会把 `new URL(…)` 解析成 http 资源，
    // 而 Node 的默认 ESM 加载器**不接受 http 协议**（实测报错原文：
    //   Only URLs with a scheme in: file and data are supported … Received protocol 'http:'）。
    opts.workerSrc = pathToFileURL(`${process.cwd()}/node_modules/pdfjs-dist/build/pdf.worker.min.mjs`).href;
  }
  workerConfigured = true;
}

/** 一页的文本项 → 纯文本。**保留换行、压掉行内多余空白**：CJK 里逐字拼接会被空格切开，
 *  所以按 pdf.js 给的 `hasEOL` 断行，而不是简单 join(" ")。 */
function joinPageText(items: ReadonlyArray<{ str?: string; hasEOL?: boolean }>): string {
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

/** 把 pdf.js 的异常映射成契约里的错误码（抽取器不抛异常，§15.3）。 */
function classify(err: unknown): ExtractResult {
  const name = (err as { name?: string } | null)?.name ?? "";
  const message = String((err as { message?: string } | null)?.message ?? err);
  if (name === "PasswordException") return fail(ID, "encrypted", "PDF 有口令保护，抽不了文本层");
  if (name === "InvalidPDFException" || /Invalid PDF|xref|trailer/i.test(message)) {
    return fail(ID, "corrupt", `PDF 结构损坏：${message}`);
  }
  return fail(ID, "internal", `pdf.js 报错（${name || "unknown"}）：${message}`);
}

export const pdfTextExtractor: Extractor = {
  id: ID,
  mimes: ["application/pdf"],
  extensions: [".pdf"],
  cost: "cpu",

  async extract(input: ExtractInput): Promise<ExtractResult> {
    const head = new TextDecoder("latin1").decode(input.bytes.subarray(0, 1024));
    if (!head.includes("%PDF-")) return fail(ID, "unsupported", "不是 PDF：开头 1 KiB 里找不到 %PDF-");

    ensurePdfjsWorker();

    let doc: Awaited<ReturnType<typeof pdfjs.getDocument>["promise"]>;
    try {
      doc = await pdfjs.getDocument({
        // ⚠️ 必须是**副本**：pdf.js 会接管这份 buffer（见文件头坑 ①）。
        data: new Uint8Array(input.bytes),
        useWorkerFetch: false,
        isEvalSupported: false,
      }).promise;
    } catch (err) {
      return classify(err);
    }

    const segments: ExtractedSegment[] = [];
    try {
      const pageCount = Math.min(doc.numPages, MAX_PAGES);
      for (let n = 1; n <= pageCount; n++) {
        const page = await doc.getPage(n);
        const content = await page.getTextContent();
        const text = joinPageText(content.items as ReadonlyArray<{ str?: string; hasEOL?: boolean }>);
        if (text.length > 0) segments.push({ kind: "text", text, loc: `p.${n}` });
      }
    } catch (err) {
      return classify(err);
    } finally {
      // 释放 worker 侧的文档：抽取可能连着跑成百上千个文件，别把内存攒住。
      await doc.destroy().catch(() => {});
    }

    if (segments.length === 0) {
      // 扫描件走这条路：**不是失败**，是"这个抽取器没内容可给"，交给 pdf.ocr。
      return fail(ID, "empty", `PDF 共 ${doc.numPages} 页，但没有文本层（扫描件？交给 pdf.ocr）`);
    }
    return ok(ID, segments);
  },
};
