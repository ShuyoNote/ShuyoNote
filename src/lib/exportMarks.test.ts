// 判据：导出 Markdown 时，**drawing → 图片附件**、**多栏 → HTML `<table>`**（owner 2026-10-19）。
//
// 两条都是"结构会丢"的那一类：旧实现里 Excalidraw 只留图上的文字（纯图形的图**整段消失**），
// 多栏把各列文字竖着拼（并排关系消失）。⇒ 这里用**真导出函数**跑一遍，钉住输出形状。
import { describe, expect, it } from "vitest";

import { pageContentToMarkdown } from "./exportMarkdown";
import { DRAWING, SHUYONOTE_TRANSFORMERS } from "../editor/markdownTransformers";

function doc(children: unknown[]) {
  return JSON.stringify({
    root: { children, direction: null, format: "", indent: 0, type: "root", version: 1 },
  });
}
function para(text: string) {
  return {
    children: [{ detail: 0, format: 0, mode: "normal", style: "", text, type: "text", version: 1 }],
    direction: "ltr",
    format: "",
    indent: 0,
    type: "paragraph",
    version: 1,
  };
}

describe("导出 Markdown：drawing 与多栏", () => {
  it("① drawing 有缩略图 ⇒ 导出成图片附件引用", () => {
    const drawing = {
      type: "drawing",
      version: 1,
      hash: "scene123",
      mime: "application/json",
      thumbHash: "thumb456",
      thumbMime: "image/png",
      text: "图上文字",
      width: 600,
      height: 400,
    };
    const md = pageContentToMarkdown(doc([para("前"), drawing, para("后")]));
    expect(md, "应导出成图片附件引用").toContain("![drawing](attachments/thumb456.png)");
    // ⛔ 不许再只留"图上文字"当正文的替代品（那是旧行为）
    expect(md).not.toMatch(/^图上文字$/m);
  });

  it("② drawing 没有缩略图 ⇒ 退回图上文字（⛔ 不编造路径）", () => {
    const drawing = {
      type: "drawing",
      version: 1,
      hash: "scene123",
      mime: "application/json",
      thumbHash: null,
      text: "流程 A→B",
    };
    const md = pageContentToMarkdown(doc([drawing]));
    expect(md).toContain("流程 A→B");
    expect(md, "没有缩略图就不许出现图片链接").not.toContain("![drawing]");
  });

  it("③ 多栏 ⇒ HTML <table>，一行多格、换行转 <br>、文字转义", () => {
    const colJson = (text: string) =>
      JSON.stringify({ root: { children: [para(text)], type: "root", version: 1 } });
    const columns = {
      type: "columnsBlock",
      version: 1,
      count: 2,
      cols: [colJson("左栏第一行"), colJson("右栏 <b>内容</b>")],
      widths: [50, 50],
    };
    const md = pageContentToMarkdown(doc([para("上"), columns, para("下")]));
    expect(md, "必须是表格").toContain("<table><tbody><tr>");
    expect(md, "两栏在同一行").toMatch(/<tr>.*<td>左栏第一行<\/td>.*<td>.*<\/td>.*<\/tr>/);
    expect(md, "文字要转义（否则内容里的 < 会破坏结构）").toContain("&lt;b&gt;内容&lt;/b&gt;");
    // ⛔ 旧行为（竖着拼）不许回来
    expect(md).not.toMatch(/^左栏第一行\n右栏/m);
  });

  // ⭐⭐ **2026-10-19（真机事故：加了 DRAWING 之后「多栏不能编辑」）**：
  //   `SHUYONOTE_TRANSFORMERS` 还被 `ColumnEditor`（分栏里每一格的编辑器）共用，
  //   而它的节点表里**没有 `DrawingNode`** ⇒ transformer 的 `dependencies` 一旦写上，
  //   分栏编辑器挂 `MarkdownShortcutPlugin` 时就会抛 "node not configured" ⇒ 整格编辑不了 ✓。
  //   ⇒ 本判据钉住：**DRAWING 的 dependencies 必须是空数组**（只导出、不导入 ⇒ 不需要依赖）。
  //   **变异**：把 `[]` 改回 `[DrawingNode]` ⇒ 这一条必红。
  it("④ DRAWING 不许声明 dependencies（否则分栏编辑器挂不上插件 ⇒ 多栏不能编辑）", () => {
    expect(DRAWING.dependencies, "DRAWING 的 dependencies 必须是空数组").toEqual([]);
    expect(SHUYONOTE_TRANSFORMERS, "DRAWING 必须真的在导出表里（否则等于没加）").toContain(DRAWING);
  });
});
