// **P0 格式引擎**（Kreuzberg v4.10.x，MIT ✓）—— 补本仓 TS 链吃不下的一类。
//
// ## 它补的是什么（2026-10-02 实测的缺口）
// 本仓既有各族对下面这些格式**没有读数**（`no_extractor`）：`eml` / `msg` / `zip` / `7z` / `gz` / `tar` /
// `rtf` / `odt|ods|odp` / `epub` / `tex` / `bib` / `ris`。
// 而 `kz-p0` 那轮实测（同一批文件、真跑）：eml 388 字 ✓ rtf 101 ✓ zip 1945 ✓ csv 108 ✓ html 85 ✓ md 194 ✓。
//
// ## 三条刻意口径（**照 `legacy.ts` 抄，别自己发明**）
//  1. **只回文本**：⛔ 本抽取器**不写派生表** ✗ —— `attachment_text` / `chunks` 的唯一写入者仍是
//     本目录那条链（门禁 `check-derived-writers` 守的就是这条 ✓）。
//  2. **未注入 `deps.kreuzbergExtract` ⇒ `provider_error`**（§15.3-7）：
//     如实说"这条通道现在不通"，**既不抛穿、也不自建客户端** ✓（与 `legacy.ts` 的 `convertLegacy` 同一条 ✓）。
//  3. **抽取器不许 import `src/lib/platform/**`** —— 有源码级断言（`isolated.test.ts`）守着 ✓；
//     真正的原生调用在平台层（那条 Rust 命令 `extract_with_kreuzberg` 收 base64 ✓）。
//
// ## 为什么 `mimes` 要**刻意窄**
// 注册表是"**先按 mime 整表比、再按扩展名**"（`registry.ts` 头部）⇒ 列宽了会**抢别族的活** ✗：
// `application/pdf` 归 `pdf.ts` ✓、`text/html` 归 `html.ts` ✓、OOXML 与旧 Office 归那两族 ✓、
// `audio/*` / `video/*` 归 `avTranscript.ts` ✓ —— 这里**只列上述缺口那一批** ✓。
// ⚠️ `text/rtf` 会被 `text.ts` 的 `text/*` 认领 ⇒ 所以本抽取器在注册表里**必须排在 `textExtractor` 前面** ✗

import { fail, type ExtractInput, type ExtractResult, type Extractor } from "./types";

export const KREUZBERG_ID = "kreuzberg.p0@1";

/** 本族认领的 MIME（**只列缺口那一批** ✓ 见文件头"为什么窄"）。 */
export const KREUZBERG_MIMES: readonly string[] = [
  // 邮件
  "message/rfc822",
  "application/vnd.ms-outlook",
  // 富文本 / 文字处理（非 OOXML、非旧 OLE）
  "application/rtf",
  "text/rtf",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation",
  // 压缩包 / 归档
  "application/zip",
  "application/x-7z-compressed",
  "application/gzip",
  "application/x-gzip",
  "application/x-tar",
  // 电子书
  "application/epub+zip",
  // 学术 / 出版
  "application/x-tex",
  "text/x-tex",
  "application/x-bibtex",
  "application/x-research-info-systems",
];

/** 扩展名兜底（mime 缺失 / `application/octet-stream` 时；与别族同一约定 ✓）。 */
export const KREUZBERG_EXTENSIONS: readonly string[] = [
  ".eml", ".msg",
  ".rtf",
  ".odt", ".ods", ".odp",
  ".zip", ".7z", ".gz", ".tgz", ".tar",
  ".epub",
  ".tex", ".latex", ".bib", ".ris",
];

export const kreuzbergExtractor: Extractor = {
  id: KREUZBERG_ID,
  mimes: KREUZBERG_MIMES,
  extensions: KREUZBERG_EXTENSIONS,
  cost: "cpu", // 进程内推理（Rust 侧），不吃 GPU ✓ —— 与 avTranscript 的 cost:"gpu" 不同类 ✓
  async extract(input: ExtractInput): Promise<ExtractResult> {
    const run = input.deps?.kreuzbergExtract;
    if (!run) {
      return fail(
        KREUZBERG_ID,
        "provider_error",
        "这一族格式（邮件/压缩包/RTF/ODT/EPUB/学术格式）需要平台提供 P0 格式引擎" +
          "（`deps.kreuzbergExtract`，桌面侧实现在 `src-tauri` 的原生命令 `extract_with_kreuzberg`）：" +
          "本平台没有提供它（Web 端没有、桌面端在平台接上之前也不会提供）⇒ " +
          "**如实回答「抽不了」**，而不是自己起外部程序或自带一份引擎（§15.3-7）",
      );
    }
    let out: { text: string; engine: string };
    try {
      out = await run(input.bytes, input.mime, input.filename);
    } catch (e) {
      // 契约要求**一律 reject**（引擎不在 / IPC 出错 / 引擎内部报错）⇒ 这里统一映射成 provider_error
      // ⚠️ 与 `legacy.ts` 同一条口径：**不把"通道不通"伪装成"文件有问题"** ✓
      const msg = e instanceof Error ? e.message : String(e);
      return fail(KREUZBERG_ID, "provider_error", `P0 格式引擎抽取失败：${msg}`);
    }
    const text = String(out?.text ?? "");
    if (text.trim().length === 0) {
      // ⚠️ 引擎回成功但没字 ⇒ 如实说"空"（同 `text.ts` 的 `empty` ✓）；⛔ 不编造定位、不塞占位文本 ✗
      return fail(KREUZBERG_ID, "empty", `P0 格式引擎抽出来是空的（引擎 ${out?.engine || "?"}）`);
    }
    // ⚠️ `loc` 给空串：本族**没有页/行级定位**（引擎只回纯文本）⇒ 不许编造 ✓（同 avTranscript 的"不编造定位"）
    return {
      ok: true,
      extractor: KREUZBERG_ID,
      segments: [{ kind: "text", text, loc: "" }],
    };
  },
};
