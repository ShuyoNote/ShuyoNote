import { describe, expect, it } from "vitest";
import { markdownToPageContent, mdNodeClasses } from "./mdPreview";

describe("markdownToPageContent", () => {
  it("converts plain markdown to Lexical JSON + plain text", () => {
    const r = markdownToPageContent("# 标题\n\n正文 **加粗**");
    expect(r).not.toBeNull();
    expect(r!.content_text).toContain("标题");
    expect(r!.content_text).toContain("加粗");
    const parsed = JSON.parse(r!.content_json);
    expect(Array.isArray(parsed.root.children)).toBe(true);
    expect(parsed.root.children.length).toBeGreaterThan(0);
    expect(parsed.root.children[0].type).toBe("heading");
  });

  it("converts a list with nesting", () => {
    const r = markdownToPageContent("- a\n- b\n- c");
    expect(r!.content_text).toContain("a");
    expect(r!.content_text).toContain("c");
    const parsed = JSON.parse(r!.content_json);
    expect(parsed.root.children[0].type).toBe("list");
  });

  it("converts a code block preserving language", () => {
    const r = markdownToPageContent("```ts\nconst x = 1;\n```");
    expect(r!.content_text).toContain("const x = 1;");
  });

  it("returns null for empty / whitespace input", () => {
    expect(markdownToPageContent("")).toBeNull();
    expect(markdownToPageContent("   ")).toBeNull();
  });

  it("routes block HTML through the HTML import path", () => {
    const r = markdownToPageContent("<p>html 段落</p>");
    expect(r).not.toBeNull();
    expect(r!.content_text).toContain("html 段落");
  });

  // ★ 2026-09-23（用户截图：社区链接存笔记 → `Minified Lexical error #365`）：
  //   下标 9（`ColumnsBlockNode`）在**打包产物**里是 `undefined` —— 循环 import 让模块级节点表
  //   在类还没赋值时就被求值。这条单测只能守住"表里每一项都是可构造的节点类"（漏了 export /
  //   写错名字这一档），**守不住**打包次序那一档（ESM 下永远绿）；那一档的判据只能是打包产物里跑，
  //   见 `mdNodes()` 头注。
  it("节点表里每一项都是可构造的节点类（不是 undefined）", () => {
    const classes = mdNodeClasses();
    expect(classes.length).toBeGreaterThanOrEqual(21);
    const bad = classes.map((c, i) => [i, c]).filter(([, c]) => typeof c !== "function");
    expect(bad).toEqual([]);
  });
});
