// 「**老的二进制 `.doc` 能一键导入吗？**」（owner 2026-10-12 原话）· 判据 ＋ 边界。
//
// ## 先说结论（两条都是**读代码**核出来的，⛔ 没跑真机 ✗）
// ⭐ **不能"一键"** —— 三个"导入"入口**都不放开 `.doc`**：
//   · 「从导入文件创建…」`MarkdownImportDialog.tsx:30` filter ＝ `["md","markdown","txt","docx","docm"]`
//   · 右下角面板 `OfficeImportPanel.tsx:89` filter ＝ `["docx"]`
//   · 附件/文件行的右键「转成笔记」只在 `.(docx|docm)$` 时出现（`PageTree.tsx:440`／`FileManagerView.tsx:1281`）
// ⚠️ 而"导入为笔记"那条链**只解析 docx**：`importPipeline.ts:12,73` **直接调** `docxToNoteBlocks`
//   （手写 TS，`src/lib/extract/ooxml.ts`）—— ⛔ 它**没有**经过抽取器注册表 ✓ ⇒ 即便字节进来了，
//   `.doc` 也会被 `ooxml.ts:1106-1108` 判成 `legacy_or_encrypted` 并给出人话
//   （逐字：「这是 OLE 复合文档：**旧式 .doc** 或**加密**的 .docx ⇒ 第一期只认未加密的 .docx；
//     请先用 Word/WPS「另存为 .docx」再导入」✓）—— ⭐ 所以**不是静默失败** ✓。
// ⭐ 而"抽取/索引"那条**另一条**链**认得** `.doc`（`src/lib/extract/legacy.ts:61,82`：`.doc/.dot/.xls/.xlt/.ppt/.pot`），
//   代价是要**平台转换器**（桌面侧 ＝ LibreOffice，`legacy_convert.rs:1-5`／`SOFFICE_MISSING:43-45`）⇒
//   ⚠️ **两条链不一致**：抽取层"认"、导入链"不认" ✓ —— 这正是下面 ② 要钉的那件事 ✓。
//
// ## 这两条判据为什么值得写
// `AbilitiesPane.test.tsx:286-288` 已经钉过同族的坑（"拿相邻的东西当证据"：用户面写了 `Excel/PPT/xlsx/pptx`
// 而导入链一次都没调它们 ✗）⇒ 本文件把同一件事**扩到 `.doc` 这一族**，并补上"选不到就得说清"那半 ✓。
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(p, "utf8");

/** ⛔ 注释不算文案（`relayStatus.test.ts` ② 踩过那个坑：注释里引旧文案 ⇒ 判据自绊 ✗）。 */
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("//") || t.startsWith("/*") || t.startsWith("*") || t.startsWith("*/"));
    })
    .join("\n");

/** 两个"一键导入"入口（第三个入口是右键「转成笔记」，它按扩展名才出现 ⇒ 见 ②）。 */
const ENTRIES = [
  { file: "src/components/MarkdownImportDialog.tsx", where: "「从导入文件创建…」" },
  { file: "src/components/OfficeImportPanel.tsx", where: "「选择 .docx 文件」" },
] as const;

/** ⭐ 抽取层认的**旧二进制 Office** 扩展名（逐字取自 `src/lib/extract/legacy.ts:82`）。 */
const LEGACY_EXT = [".doc", ".dot", ".xls", ".xlt", ".ppt", ".pot"] as const;

describe("老的二进制 .doc 能不能一键导入", () => {
  /**
   * ⭐ **owner 的问题就是这条判据**：用户手里那个 `.doc`，在三处导入入口上**都选不到** ⇒
   * 那么界面**至少得有一句人话**告诉他"老格式怎么办"（⭐ 本仓既有先例：`ooxml.ts:1108` 那句
   * "请先用 Word/WPS「另存为 .docx」再导入" ✓ —— ⚠️ 那句只在**字节已经进来**之后才会出现，
   * 而**没有任何入口**能让它进来 ✗ ⇒ 用户永远看不到它 ✓）。
   *
   * ⇒ 判据：两个导入入口的**代码/文案行**里，必须有一处点名"旧格式 / 另存为"这一档 ✓。
   * ⭐ **先红后绿（2026-10-12）**：改动前两处都没有（`OfficeImportPanel.tsx:182` 只说
   *    "第一期只做 .docx 单文件"——那是**边界**不是**出路** ✗）⇒ 实测红（逐字：
   *    `expected false to be true` ✓）；owner 拍「甲：只把话说清」之后两处各补一句 ⇒ 现在**绿** ✓。
   *    ⚠️ ⛔ **变绿的唯一正路是补那句话** ✗ —— 不许把 `.doc` 加进 filter（② 挡的就是那个 ✓）。
   */
  it("① 选不到 ⇒ 就必须说得清：导入入口里要有一句「老格式请另存为 .docx」（2026-10-12 前是红的 ✓）", () => {
    const copy = ENTRIES.map((e) => codeOnly(read(e.file))).join("\n");
    const legacyMentioned = LEGACY_EXT.some((x) => copy.includes(`"${x}"`));
    const toldWhatToDo = /另存为|旧格式|旧版 Office|老格式/.test(copy);
    expect(
      legacyMentioned || toldWhatToDo,
      "两个「一键导入」入口都选不到 .doc（filter 只有 docx 族），而它们的文案里**也没有一句**" +
        "告诉用户老格式怎么办（另存为 .docx）⇒ owner 拿着 .doc 既选不到、也问不出为什么 ✗",
    ).toBe(true);
    // ⚠️ 这一条**不许**用"改判据"的方式变绿 ⇒ 修法见报告 §4：最小那一档是**加一句话** ✓。
  });

  /**
   * ② 反向（⭐ **今天绿**，它挡的是"接线接一半"）：导入链**只解析 docx** ⇒
   * 那么两个入口的 `extensions: [...]` 里**不许**出现导入链解析不了的扩展名 ✓。
   * ⚠️ 将来谁把 `legacyExtractor`（`.doc` 那族）真的接到导入链上 ⇒ 这条与 ① **要一起改** ✓
   * （`importPipeline.ts` 里出现 `convertLegacy`／`legacyExtractor` 时，下面那句会先红 ⇒ 提醒你同步放开 filter ＋改文案 ✓）。
   */
  it("② 反向（今天绿）：导入链只认 docx ⇒ 对话框 filter 里不许冒出它解析不了的扩展名", () => {
    const pipeline = codeOnly(read("src/lib/office/importPipeline.ts"));
    expect(pipeline, "Word 导入链没调 docx 解析器 ⇒ 判据要重写").toContain("docxToNoteBlocks");
    expect(
      /legacyExtractor|convertLegacy/.test(pipeline),
      "导入链里出现了旧格式转换器 —— 那 filter 与文案必须**一起**放开/改口（① 也要一起改）",
    ).toBe(false);

    // 导入链真正能解析的：md/markdown/txt（走 `api.readTextFile` ✓）＋ docx/docm（走 `docxToNoteBlocks` ✓）。
    const PARSABLE = ["md", "markdown", "txt", "docx", "docm"];
    for (const e of ENTRIES) {
      const src = codeOnly(read(e.file));
      const m = /extensions:\s*\[([^\]]*)\]/.exec(src);
      expect(m, `${e.file} 里找不到 extensions: [...] ⇒ 判据要重写（形状变了）`).not.toBeNull();
      for (const hit of m![1].matchAll(/"([^"]+)"/g)) {
        expect(PARSABLE, `${e.where} 放开了「${hit[1]}」—— 而导入链解析不了它 ✗`).toContain(hit[1]);
      }
    }
  });
});
