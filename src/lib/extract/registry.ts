// 抽取器注册与分派 —— 契约见 docs/plans/2026-09-17-knowledge-base-ai-coverage-plan.md §15.4。
//
// 刻意的两个设计：
//  1) **注册表是显式数组，不做自动扫描** —— 自动扫描在打包/沙盒环境下不可预测，且无法审计
//     "到底注册了哪些抽取器"；
//  2) **先整表比 mime，再整表比扩展名**（不是每个抽取器自己先比 mime 再比扩展名）。
//     否则一个"扩展名沾边但 mime 更准"的抽取器会抢在正确的那一个前面。

import { htmlExtractor } from "./html";
import { imageCaptionExtractor, imageOcrExtractor } from "./image";
import { pdfTextExtractor } from "./pdf";
import { pdfOcrExtractor } from "./pdfOcr";
import { OOXML_EXTRACTORS } from "./ooxml";
import { textExtractor } from "./text";
import { avTranscriptExtractor } from "./avTranscript";
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
 * 按「mime → 扩展名」的顺序挑**全部**候选抽取器（保持注册表顺序、去重）。
 *
 * 契约 §15.4：一个格式允许多个抽取器（例：PDF 的 `pdf.text` 抽不出东西时再试 `pdf.ocr`），
 * 所以调度器需要"候选列表"而不是"唯一一个"。**试谁、按什么顺序、什么时候换人属 P1 实现细节**，
 * 不在契约内。
 */
export function candidates(
  mime: string,
  filename: string,
  registry: readonly Extractor[],
): Extractor[] {
  const m = normalizeMime(mime);
  const out: Extractor[] = [];
  const seen = new Set<Extractor>();
  for (const ex of registry) {
    if (mimeMatches(ex.mimes, m) && !seen.has(ex)) {
      out.push(ex);
      seen.add(ex);
    }
  }
  const ext = extensionOf(filename);
  if (ext) {
    for (const ex of registry) {
      if (ex.extensions.some((e) => String(e).toLowerCase() === ext) && !seen.has(ex)) {
        out.push(ex);
        seen.add(ex);
      }
    }
  }
  return out;
}

/**
 * 按同一顺序挑**第一个**候选；都没有则 null（调度器记 `unsupported`）。
 *
 * 同名冲突先到先得，由 `registry` 顺序决定（契约 §15.4）。
 */
export function pickExtractor(
  mime: string,
  filename: string,
  registry: readonly Extractor[],
): Extractor | null {
  return candidates(mime, filename, registry)[0] ?? null;
}

/** 本线 P1 的显式注册表（新增抽取器在这里登记；不要改成自动扫描）。
 *
 * **顺序即优先级**（同名冲突先到先得），所以把一个格式的"便宜的抽取器"排在"贵的"前面。
 *
 * P1 进度（2026-09-17）：
 *  - ✅ OOXML 一族（`ooxml.docx@1` / `ooxml.xlsx@1` / `ooxml.pptx@1`），cost=cpu
 *  - ✅ 图片 OCR（`image.ocr@1`），cost=gpu —— 也是契约 §15.3-7 那条不变量的活样板
 *  - ✅ 纯文本（`text.plain@1`）—— 补上"txt/md/csv 直读"那一行（真样张跑器发现整目录 `.md` 全是
 *    `no_extractor` 才补的）
 *  - ✅ HTML（`text.html@1`）—— **同一次真样张**里 `.html` 也是 `no_extractor`（保存的网页很常见）
 *  - ✅ PDF 视觉通道（`pdf.ocr@1`），cost=gpu —— 扫描件/混合文档；**只对没有文本层的页**做视觉
 *  - ✅ 图片语义描述（`image.caption@1`），cost=gpu —— 2026-09-19 落地；**只在 OCR 判 empty 时被调度**
 *  - ✅ 音视频转写（`av.transcript@1`），cost=gpu —— 2026-09-22 落地；**能力与抽取器同批进契约**
 *    （`ExtractDeps.transcribe?` ＋ `DEP_CAPABILITIES` ＋ 方案 §15.8 ＋ 本表 ＋ conformance 夹具，
 *    五处必须同批：只登记能力不落地抽取器、或落了抽取器不带夹具，判据都会当场红）
 *  - ⏳ 待补：`ooxml.xls`（旧格式，需 LibreOffice headless）
 */
export const REGISTRY: readonly Extractor[] = [
  ...OOXML_EXTRACTORS,
  imageOcrExtractor,
  // ⚠️ 顺序即优先级：`image.ocr` 排在 `image.caption` **前面** —— 图里有文字就用文字
  //    （检索要的是可命中的原文），**只有 OCR 判 `empty`（照片/纯图形）才轮到语义描述**
  //    （调度规则见 pipeline.ts：只对 `unsupported` / `empty` 换下一个候选，§15.4）。
  //    ⇒ 已知取舍（2026-09-19）：一张**带文字的**图今天只出 OCR 文本、不出描述。
  //      要让两者都进库得改调度语义（"合并多个抽取器"要先定义谁赢），那是另一件事，别顺手加。
  imageCaptionExtractor,
  // ⚠️ 顺序即优先级：pdf.text 必须排在 pdf.ocr **前面**（先试便宜的文本层，抽不到才上视觉）。
  //    调度规则见 pipeline.ts：`pdf.text` 返回 `empty` 时才会换到 `pdf.ocr`（§15.4）。
  pdfTextExtractor,
  pdfOcrExtractor,
  // ⚠️ html 必须排在 text.plain **前面**：后者的 `text/*` 也匹配 `text/html`，
  //    而按注册表顺序先到先得 ⇒ 放反了，HTML 会被当成纯文本**原样读出标签**。
  htmlExtractor,
  // 纯文本放最后：它的扩展名不与上面几族重叠，放最后是为将来"更具体的纯文本子类"留位
  textExtractor,
  // ⚠️ 音视频转写：`audio/*` / `video/*` 与上面几族**零重叠**，所以位置不影响分派；
  //    它单独排在这里是因为它**与别族不同类**（最贵、且要 `deps.transcribe` 注入）。
  //    没注入 transcribe ⇒ `provider_error`（不抛、不自建客户端，§15.3-7）——
  //    在平台侧把 `attachmentDeps` 接上 ASR 端点之前，**这是预期状态不是 bug**。
  avTranscriptExtractor,
];
