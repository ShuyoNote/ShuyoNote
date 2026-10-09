// **docx ⇒ 块 ⇒ Markdown 的转换判据**（Office 导入第一期 · 2026-10-09）。
//
// 这里验的是"**转得对**"（保留率的读数在 `retention.test.ts` ✓）；样本来自 `sampleDocx.ts`
// 现造的真 docx（zip ＋ OOXML ✓），⛔ 仓库里不留二进制样张 ✓。
//
// ⚠️ 失败分类那几条的**期望码**钉在这里（`empty` / `not_zip` / `legacy_or_encrypted` /
//    `no_document` / `empty_body`）—— 它们是"可读失败"的可核形态 ✓。

import { describe, expect, it } from "vitest";

import { docxToNoteBlocks, type NoteBlock } from "../extract/ooxml";
import { blocksToMarkdown } from "./docxMarkdown";
import { brokenSamples, buildSampleDocx, officeSamples, samplePng } from "./sampleDocx";

function parseFull() {
  const full = officeSamples()[1];
  const parsed = docxToNoteBlocks(full.bytes);
  expect(parsed.ok, parsed.ok ? "" : `应当转成功，实际失败：${parsed.code} ${parsed.message}`).toBe(true);
  if (!parsed.ok) throw new Error(parsed.message);
  return { full, parsed };
}

describe("docx ⇒ 块（解析层）", () => {
  it("五类齐全样本：源的计数与转出的块数都对得上", () => {
    const { full, parsed } = parseFull();
    expect(parsed.source).toEqual(full.truth);
    expect(parsed.converted).toEqual(full.truth);
  });

  it("标题层级按 `Heading N` 取（1..6 夹紧）；列表按 numPr 取层级与有序/无序", () => {
    const { parsed } = parseFull();
    const blocks = parsed.blocks;
    const heading = blocks.find((b) => b.kind === "heading");
    expect(heading).toMatchObject({ kind: "heading", level: 1, text: "2026 年第三季度总结" });
    const headings = blocks.filter((b) => b.kind === "heading").map((b) => (b.kind === "heading" ? b.level : 0));
    expect(headings).toEqual([1, 2, 2]);

    const lists = blocks.filter((b) => b.kind === "list");
    expect(lists.map((b) => (b.kind === "list" ? b.ordered : null))).toEqual([
      false,
      false,
      false,
      true,
      true,
      true,
    ]);
    expect(lists.map((b) => (b.kind === "list" ? b.level : -1))).toEqual([0, 1, 1, 0, 0, 0]);
    // 有序列表的序号**按文档顺序**从 1 数（Word 的编号在 md 里要显式写出来 ✓）
    expect(lists.filter((b) => b.kind === "list" && b.ordered).map((b) => (b.kind === "list" ? b.marker : ""))).toEqual([
      "1.",
      "2.",
      "3.",
    ]);
  });

  it("强调（粗/斜/删除线）⇒ md 标记", () => {
    const { parsed } = parseFull();
    const emph = parsed.blocks.find(
      (b) => b.kind === "paragraph" && b.text.includes("重点项目"),
    );
    expect(emph?.kind === "paragraph" ? emph.text : "").toBe("**重点项目：***海外版*~~旧口径已作废~~");
  });

  it("图片：字节真的取出来了（67 B 的 PNG ＋ 正确的 mime），重复引用只给一份字节", () => {
    const { parsed } = parseFull();
    expect(parsed.images).toHaveLength(1); // 两个引用指向同一张 media ⇒ 去重
    expect(parsed.images[0].mime).toBe("image/png");
    expect(parsed.images[0].name).toBe("image1.png");
    expect(parsed.images[0].bytes.length).toBe(samplePng().length);
    expect(parsed.converted.images).toBe(2); // 但正文里两个位置各有一个图块 ✓
  });

  it("表格：列数按 `w:tblGrid` 对齐（某行少一格 ⇒ 补空格，不把列错位）", () => {
    const bytes = buildSampleDocx([
      {
        t: "table",
        rows: [
          ["甲", "乙", "丙"],
          ["只有两格", "二"],
        ],
      },
    ]);
    const parsed = docxToNoteBlocks(bytes);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const table = parsed.blocks.find((b) => b.kind === "table");
    expect(table?.kind === "table" ? table.rows : []).toEqual([
      ["甲", "乙", "丙"],
      ["只有两格", "二", ""],
    ]);
  });

  it("分母只数**有内容的**构造：空段落不算（否则真文档的保留率会凭空变低）", () => {
    const bytes = buildSampleDocx([
      { t: "p", text: "" },
      { t: "p", text: "" },
      { t: "p", text: "只有这一段有字" },
    ]);
    const parsed = docxToNoteBlocks(bytes);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.source.paragraphs).toBe(1);
    expect(parsed.converted.paragraphs).toBe(1);
  });

  it("⛔ 失败一律可读：每个坏样本都有码，且最要命那条是 `empty_body`（不是空笔记）", () => {
    for (const spec of brokenSamples()) {
      const parsed = docxToNoteBlocks(spec.bytes);
      expect(parsed.ok, `${spec.name} 竟然转成功了 ⇒ 静默空笔记`).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.message.length, `${spec.name} 的说明太短`).toBeGreaterThan(8);
      if (spec.expectCode) expect(parsed.code, `${spec.name}`).toBe(spec.expectCode);
    }
  });
});

describe("块 ⇒ Markdown（渲染层）", () => {
  const blocks: NoteBlock[] = [
    { kind: "heading", level: 2, text: "二级标题" },
    { kind: "paragraph", text: "正文一段。" },
    { kind: "list", ordered: false, level: 0, marker: "-", text: "第一项" },
    { kind: "list", ordered: false, level: 1, marker: "-", text: "嵌套项" },
    { kind: "table", rows: [["列一", "列二"], ["甲", "乙"]] },
  ];

  it("五类都渲染成 md 构造（标题/段落/列表含嵌套/表格含 GFM 分隔行）", () => {
    const { markdown } = blocksToMarkdown(blocks);
    expect(markdown).toContain("## 二级标题");
    expect(markdown).toContain("正文一段。");
    expect(markdown).toContain("- 第一项");
    expect(markdown).toContain("  - 嵌套项");
    expect(markdown).toContain("| 列一 | 列二 |");
    expect(markdown).toContain("| --- | --- |");
    expect(markdown).toContain("| 甲 | 乙 |");
  });

  it("图片：给了 resolver ⇒ `![名](地址)`；没给 ⇒ 一行说明 ＋ 计数（⛔ 不静默丢）", () => {
    const image: NoteBlock = {
      kind: "image",
      image: { name: "图1.png", mime: "image/png", bytes: samplePng() },
    };
    const withSrc = blocksToMarkdown([image], { resolveImage: () => "attachment://abc" });
    expect(withSrc.markdown).toBe("![图1.png](attachment://abc)");
    expect(withSrc.imagesRendered).toBe(1);
    expect(withSrc.imagesUnresolved).toBe(0);

    const without = blocksToMarkdown([image]);
    expect(without.imagesRendered).toBe(0);
    expect(without.imagesUnresolved).toBe(1);
    expect(without.markdown).toContain("⚠️ 图片「图1.png」");
    expect(without.warnings.join("；")).toContain("1 张图片没有进正文");
  });

  it("表格单元格里的 `|` 换成 `¦`（本仓表格导入**不做转义**，不换会列错位）并给 warning", () => {
    const result = blocksToMarkdown([
      { kind: "table", rows: [["a|b", "c"], ["d", "e"]] },
    ]);
    expect(result.markdown).toContain("| a¦b | c |");
    expect(result.markdown).not.toContain("a|b");
    expect(result.warnings.join("；")).toContain("已换成");
  });

  it("正文以 markdown 结构符号开头 ⇒ 给 warning（导入后可能被当成标题/列表）", () => {
    const result = blocksToMarkdown([
      { kind: "paragraph", text: "# 这其实是正文里的一行" },
      { kind: "paragraph", text: "1. 这也不是真列表" },
    ]);
    expect(result.warnings.join("；")).toContain("结构符号开头");
  });
});
