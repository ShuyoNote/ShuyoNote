// 旧二进制 Office（`.doc` / `.xls` / `.ppt`）—— **OLE 复合文档，不是 zip**。
//
// ## 为什么它必须走"平台转换 + 复用现成解析"
// `ooxml.ts` 的容器检查已经把这种字节判成 `encrypted`（"OLE 复合文档"）：抽取层**自己解不了**它。
// 唯一不做第二套解析的路子是：把字节交给**平台转换器**（`deps.convertLegacy`，实现在平台层，
// 桌面侧是 LibreOffice headless）转成 OOXML，然后**原样交给 `ooxml.ts` 那一族**去解析。
//
// 分工（2026-09-23，方案 §15.8 第 7 项）：**契约与夹具归 AMD**（`ExtractDeps.convertLegacy`、
// `DEP_CAPABILITIES`、三条 planned 夹具），**本抽取器归 macOS**。
//
// ## 三条刻意口径（照契约抄，别自己发明）
//  1. **`to` 由本抽取器决定**（目标 MIME）；转换器**只回字节、不回 mime**——少一处能漂的地方；
//  2. **失败一律 `provider_error`**（转换器不在 / reject / 超时 / 输出不是 OOXML），
//     与 `vision` / `transcribe` 同一条口径（§15.3-7）：**如实说"这条通道现在不通"**，
//     既不抛穿、也不自带一个转换器；
//  3. **不许写第二套 docx/xlsx/pptx 解析** —— 转换完直接把字节交给对应的 OOXML 抽取器。
//     夹具把这个钉成**可核**的：假转换器**按 `to` 分派**，要错目标就 reject。
//
// ## 落库用的 `extractor` 列仍是本族的 id
// 返回的是**承接解析那一族**的结果（段 / `kind` / `loc` 口径与它逐条相同），
// 而**写库用的 id 由管道层决定**（`pipeline.ts` 用注册表里那个 `ex.id`，即 `ooxml.legacy@1`）——
// 所以"哪个抽取器在跑"与"谁解析的字节"是两件事，不必也不该在这里改写。

import { docxExtractor, pptxExtractor, xlsxExtractor } from "./ooxml";
import { fail, type ExtractInput, type ExtractResult, type Extractor } from "./types";

export const LEGACY_ID = "ooxml.legacy@1";

// 目标 MIME 用**字面量**写在这里（而不是从 ooxml.ts 反向导出常量）：那份常量是那边的私有实现细节。
// 漂移由判据挡：`legacy.test.ts` 断言每个 `to` **确实被承接解析的那个抽取器认领**（`ex.mimes` 含它）。
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

const WORD_MIME = "application/msword";
const EXCEL_MIME = "application/vnd.ms-excel";
const POWERPOINT_MIME = "application/vnd.ms-powerpoint";

interface LegacyTarget {
  /** 转换目标（OOXML 的 MIME）—— 由**本抽取器**决定，转换器只按它分派。 */
  readonly to: string;
  /** 承接解析的 OOXML 抽取器（**唯一**一处把目标与解析器绑在一起的地方）。 */
  readonly ex: Extractor;
  /** 给人看的短名，只进错误信息（`旧表.xls → xlsx`）。 */
  readonly label: string;
}

const DOCX_TARGET: LegacyTarget = { to: DOCX_MIME, ex: docxExtractor, label: "docx" };
const XLSX_TARGET: LegacyTarget = { to: XLSX_MIME, ex: xlsxExtractor, label: "xlsx" };
const PPTX_TARGET: LegacyTarget = { to: PPTX_MIME, ex: pptxExtractor, label: "pptx" };

/** mime → 目标（mime 是**主**判据：`candidates()` 也主要按它派给我们）。 */
const BY_MIME: ReadonlyMap<string, LegacyTarget> = new Map([
  [WORD_MIME, DOCX_TARGET],
  [EXCEL_MIME, XLSX_TARGET],
  [POWERPOINT_MIME, PPTX_TARGET],
]);

/** 扩展名 → 目标（mime 缺失 / `application/octet-stream` 时的兜底，与其它抽取器同一约定）。 */
const BY_EXT: ReadonlyMap<string, LegacyTarget> = new Map([
  [".doc", DOCX_TARGET],
  [".dot", DOCX_TARGET],
  [".xls", XLSX_TARGET],
  [".xlt", XLSX_TARGET],
  [".ppt", PPTX_TARGET],
  [".pot", PPTX_TARGET],
]);

/** 纯函数：这次该转成什么、交给谁解析。认不出 ⇒ `null`（那不是我们的字节）。 */
export function legacyTargetFor(mime: string, filename: string): LegacyTarget | null {
  const m = String(mime ?? "").trim().toLowerCase();
  const byMime = BY_MIME.get(m);
  if (byMime) return byMime;
  const dot = String(filename ?? "").lastIndexOf(".");
  if (dot < 0) return null;
  return BY_EXT.get(String(filename).slice(dot).toLowerCase()) ?? null;
}

export const legacyExtractor: Extractor = {
  id: LEGACY_ID,
  mimes: [WORD_MIME, EXCEL_MIME, POWERPOINT_MIME],
  extensions: [".doc", ".dot", ".xls", ".xlt", ".ppt", ".pot"],
  cost: "cpu", // 起一个本地进程 + 复用本地解析：不吃 GPU（转换器本身不在这里排队）
  async extract(input: ExtractInput): Promise<ExtractResult> {
    const target = legacyTargetFor(input.mime, input.filename);
    if (!target) {
      // 走到这里说明注册表把我们派给了一个既不认 mime、也不认扩展名的文件（不该发生）
      return fail(LEGACY_ID, "unsupported", `不是旧二进制 Office 格式：mime=${input.mime || "（空）"}`);
    }
    const convert = input.deps?.convertLegacy;
    if (!convert) {
      return fail(
        LEGACY_ID,
        "provider_error",
        `旧二进制 Office（${target.label} 之前那一份）需要平台转换器（deps.convertLegacy）：` +
          "本平台没有提供它（Web 端没有、桌面端在装好 LibreOffice 之前也不会提供）⇒ " +
          "**如实回答「抽不了」**，而不是自己起外部程序或自带一份转换器（§15.3-7）",
      );
    }
    let converted: Uint8Array;
    try {
      converted = await convert(input.bytes, input.mime, { to: target.to });
    } catch (e) {
      // 转换器不在 / 非零退出 / 超时 / 输出不是 OOXML —— 契约要求**一律 reject**，这里统一映射
      const msg = e instanceof Error ? e.message : String(e);
      return fail(LEGACY_ID, "provider_error", `旧格式转换失败（目标 ${target.label}）：${msg}`);
    }
    // ★ **复用同一套解析**（口径 3）：不在这里写第二套 docx/xlsx/pptx 解析。
    //   注意 `filename` 原样透传：OOXML 那一族只看字节与 mime，不看扩展名（它连 `filename` 都不读）。
    return target.ex.extract({ ...input, bytes: converted, mime: target.to });
  },
};
