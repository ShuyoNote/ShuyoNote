// ⭐ 2026-10-11（owner 同意）：⭐ docx **标题启发式**的判据 ✓。
//
// 起因（实测，不是推测）：⭐ owner 导入的那份 .docx —— 155 个段落里
//   · 用 Word「标题样式」的段落 **0** 个、带 `outlineLvl` 的 **0** 个；
//   · 字号出现 **587** 处（正文 24 半磅 ×336、18 ×217；标题档 30 ×21、36 ×8、44、40）。
// ⇒ ⭐ 原样导入就是"一坨平文本" ✓ ⇒ 加一条**保守**启发式：整段加粗 ＋ 字号明显大于正文 ⇒ 当标题 ✓。
//
// ⚠️ 这条判据的**重点在反例** ✗ —— ⭐ 启发式的命门是"误伤正文" ✓：
//   a) 正例：按字号差分成 1/2/3 级 ＋ ⭐ 报告里**必须**标明"这是猜的" ✓
//   b) 反例一：字号一样大、只是加粗 ⇒ ⛔ **不算标题**（正文里常有加粗的词句 ✓）
//   c) 反例二：又大又粗、但**以句号结尾** ⇒ ⛔ 不算（那是一句强调的话，不是标题 ✓）
//   d) 反例三：又大又粗、但**是列表项** ⇒ ⛔ 不算（列表有自己的编号体系 ✓）
//   e) 回归：⭐ 原文**真用了标题样式**的文档 ⇒ ⭐ 走老路 ✓、⭐ 且**不出现**"这是猜的"那条告警 ✓

import { describe, expect, it } from "vitest";
import { docxToNoteBlocks } from "./ooxml";
import { buildSampleDocx } from "../office/sampleDocx";

/** ⭐ 正文（⭐ 显式给字号 ⇒ 让"正文那一档"数得出来 ✓；⭐ 两条 ⇒ 稳占多数 ✓） */
const BODY = 24; // 半磅 ＝ 12pt
const bodyText =
  "这是一段正文，写得长一点，好让正文字号稳稳成为整篇里出现次数最多的那一档。" +
  "再补一句，确保它占多数，免得被标题那几档字号盖过去。";

function blocksOf(els: Parameters<typeof buildSampleDocx>[0]) {
  const r = docxToNoteBlocks(buildSampleDocx(els));
  expect(r.ok, "夹具应当能解析").toBe(true);
  if (!r.ok) throw new Error(r.message);
  return r;
}

describe("docx 标题启发式（原文没用标题样式时）", () => {
  it("a) 大字号 ＋ 整段加粗 ＋ 短 ⇒ 认成标题并按字号差分级，且报告里标明是猜的", () => {
    const r = blocksOf([
      { t: "p", text: bodyText, sz: BODY },
      { t: "p", text: bodyText, sz: BODY },
      { t: "p", text: "一级标题", sz: BODY + 12, bold: true },
      { t: "p", text: "二级标题", sz: BODY + 8, bold: true },
      { t: "p", text: "三级标题", sz: BODY + 4, bold: true },
    ]);
    const levels = r.blocks.filter((b) => b.kind === "heading").map((b) => (b as { level: number }).level);
    expect(levels, "三条应当按字号差分成 1/2/3 级").toEqual([1, 2, 3]);
    expect(r.warnings.join("；"), "⭐ 猜出来的必须在报告里标明（⛔ 不静默当成原文事实 ✗）").toContain(
      "按「整段加粗 ＋ 字号更大」推出来的",
    );
  });

  it("b) 反例：字号与正文一样、只是加粗 ⇒ ⛔ 不算标题（正文里常有加粗词句）", () => {
    const r = blocksOf([
      { t: "p", text: bodyText, sz: BODY },
      { t: "p", text: bodyText, sz: BODY },
      { t: "p", text: "这句只是加粗了一下", sz: BODY, bold: true },
    ]);
    expect(r.blocks.filter((b) => b.kind === "heading").length).toBe(0);
  });

  it("c) 反例：又大又粗、但以句号结尾 ⇒ ⛔ 不算标题（那是一句强调的话）", () => {
    const r = blocksOf([
      { t: "p", text: bodyText, sz: BODY },
      { t: "p", text: bodyText, sz: BODY },
      { t: "p", text: "这其实是一句被放大的话。", sz: BODY + 12, bold: true },
    ]);
    expect(r.blocks.filter((b) => b.kind === "heading").length).toBe(0);
  });

  it("d) 反例：又大又粗、但是列表项 ⇒ ⛔ 不算标题（列表有自己的编号体系）", () => {
    const r = blocksOf([
      { t: "p", text: bodyText, sz: BODY },
      { t: "p", text: bodyText, sz: BODY },
      { t: "li", numId: "1", level: 0, text: "被放大的列表项" },
    ]);
    expect(r.blocks.filter((b) => b.kind === "heading").length).toBe(0);
  });

  it("e) 回归：原文真用了标题样式 ⇒ 走老路，而且不出现「这是猜的」那条告警", () => {
    const r = blocksOf([
      { t: "h", level: 1, text: "真标题一" },
      { t: "h", level: 2, text: "真标题二" },
      { t: "p", text: bodyText, sz: BODY },
    ]);
    const hs = r.blocks.filter((b) => b.kind === "heading").map((b) => (b as { level: number }).level);
    expect(hs).toEqual([1, 2]);
    expect(r.warnings.join("；"), "老路上不该冒出「猜的」告警").not.toContain("推出来的");
  });

  // ⭐⭐ 2026-10-11（owner：「标题1认了，标题2没认」⇒ 一眼看出是 WPS 的中文标题样式）：
  //    ⭐ 中文 Word / WPS 把内置标题样式写成**数字 styleId** ✓，⭐ 真名字只在 `styles.xml` 里 ✓
  //    （⭐ 真样张实测：⭐ 正文是 `<w:pStyle w:val="3"/>` ✓，⭐ 而 `styles.xml` 里 `id=3` ⇒ `heading 2` ✓）
  //    ⇒ ⭐ 这一条钉"**必须按名字认**" ✓，⭐ 而且认出来**不算猜的** ✓（⛔ 不该进那条告警 ✓）。
  it("f) 数字样式 id（中文 Word/WPS 的写法）⇒ 按 styles.xml 的真名字认出来，且不算「猜的」", () => {
    const r = blocksOf([
      { t: "h", level: 1, text: "标题一（数字 id）", styleId: "2" },
      { t: "h", level: 2, text: "标题二（数字 id）", styleId: "3" },
    ]);
    const hs = r.blocks.filter((b) => b.kind === "heading").map((b) => (b as { level: number }).level);
    expect(hs, "数字 id 应当按 styles.xml 的真名字认成 1/2 级").toEqual([1, 2]);
    expect(r.warnings.join("；"), "这是按样式认出来的，⛔ 不该说成猜的").not.toContain("推出来的");
  });
});
