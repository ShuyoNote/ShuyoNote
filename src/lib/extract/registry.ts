// 抽取器注册与分派 —— 契约见 docs/plans/2026-09-17-knowledge-base-ai-coverage-plan.md §15.4。
//
// 刻意的两个设计：
//  1) **注册表是显式数组，不做自动扫描** —— 自动扫描在打包/沙盒环境下不可预测，且无法审计
//     "到底注册了哪些抽取器"；
//  2) **先整表比 mime，再整表比扩展名**（不是每个抽取器自己先比 mime 再比扩展名）。
//     否则一个"扩展名沾边但 mime 更准"的抽取器会抢在正确的那一个前面。

import { OOXML_EXTRACTORS } from "./ooxml";
import type { Extractor } from "./types";

/** 去掉 mime 参数并按小写归一：`Text/Plain; charset=utf-8` → `text/plain`。 */
export function normalizeMime(mime: string): string {
  return String(mime ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
}

/** 取小写扩展名（含点）；无扩展名时返回空串。`A.DOCX` → `.docx`。 */
export function extensionOf(filename: string): string {
  const name = String(filename ?? "");
  const slash = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
  const base = slash >= 0 ? name.slice(slash + 1) : name;
  const dot = base.lastIndexOf(".");
  // 前导点的隐藏文件（`.gitignore`）不算扩展名；末尾点也不算。
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot).toLowerCase();
}

/** mime 是否被认领：全等，或声明里以 `*` 结尾时按前缀匹配（如 `image/*`）。 */
function mimeMatches(declared: readonly string[], mime: string): boolean {
  if (!mime) return false;
  for (const d of declared) {
    const decl = normalizeMime(d);
    if (!decl) continue;
    if (decl.endsWith("*")) {
      if (mime.startsWith(decl.slice(0, -1))) return true;
    } else if (decl === mime) {
      return true;
    }
  }
  return false;
}

/**
 * 按「mime → 扩展名」的顺序挑第一个认领的抽取器；都不认则 null（调度器记 `unsupported`）。
 *
 * 同名冲突先到先得，由 `registry` 顺序决定（契约 §15.4）。
 */
export function pickExtractor(
  mime: string,
  filename: string,
  registry: readonly Extractor[],
): Extractor | null {
  const m = normalizeMime(mime);
  for (const ex of registry) {
    if (mimeMatches(ex.mimes, m)) return ex;
  }
  const ext = extensionOf(filename);
  if (ext) {
    for (const ex of registry) {
      if (ex.extensions.some((e) => String(e).toLowerCase() === ext)) return ex;
    }
  }
  return null;
}

/** 本线 P1 的显式注册表（新增抽取器在这里登记；不要改成自动扫描）。
 *
 * P1 进度（2026-09-17）：OOXML 一族（docx / xlsx / pptx）已落地并带单测。
 * 待补：`pdf.text`（复用 pdfium/pdf.js 文本层）、`pdf.ocr`、`image.ocr` / `image.vlm`、
 * `ooxml.xls`（旧格式，需 LibreOffice headless）、`av.transcript`（音视频，最贵，默认关）。
 */
export const REGISTRY: readonly Extractor[] = [...OOXML_EXTRACTORS];
