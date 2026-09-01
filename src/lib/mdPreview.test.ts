import { describe, expect, it } from "vitest";
import { markdownToPageContent } from "./mdPreview";

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
});
