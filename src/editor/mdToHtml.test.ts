import { describe, expect, it } from "vitest";
import { inlineToHtml, mdToHtml } from "./mdToHtml";

describe("mdToHtml block constructs", () => {
  it("converts headings", () => {
    expect(mdToHtml("# 标题")).toContain("<h1>标题</h1>");
    expect(mdToHtml("## 二级")).toContain("<h2>二级</h2>");
    expect(mdToHtml("###### 六级")).toContain("<h6>六级</h6>");
  });

  it("converts unordered and ordered lists", () => {
    expect(mdToHtml("- a\n- b")).toBe("<ul><li>a</li><li>b</li></ul>");
    expect(mdToHtml("1. x\n2. y")).toBe("<ol><li>x</li><li>y</li></ol>");
  });

  it("converts fenced code with language", () => {
    expect(mdToHtml("```js\nconst a = 1;\n```")).toBe('<pre><code class="language-js">const a = 1;</code></pre>');
  });

  it("converts blockquote and horizontal rule", () => {
    expect(mdToHtml("> 引用")).toContain("<blockquote>引用</blockquote>");
    expect(mdToHtml("---")).toContain("<hr>");
  });

  it("wraps a plain paragraph", () => {
    expect(mdToHtml("hello world")).toBe("<p>hello world</p>");
  });

  it("passes raw HTML blocks through verbatim", () => {
    const html = "<div class=\"x\"><p>内嵌</p></div>";
    expect(mdToHtml(html)).toContain(html);
  });

  it("emits a mermaid container", () => {
    const out = mdToHtml("```mermaid\ngraph TD; A-->B;\n```");
    expect(out).toContain("fm-md-mermaid");
    expect(out).toContain("fm-md-mermaid-src");
  });

  it("converts a markdown table", () => {
    const out = mdToHtml("| a | b |\n|---|---|\n| 1 | 2 |");
    expect(out).toContain("<table>");
    expect(out).toContain("<th>a</th><th>b</th>");
    expect(out).toContain("<td>1</td><td>2</td>");
  });
});

describe("inlineToHtml", () => {
  it("bold / italic / strikethrough", () => {
    expect(inlineToHtml("**加粗**")).toBe("<strong>加粗</strong>");
    expect(inlineToHtml("*斜体*")).toBe("<em>斜体</em>");
    expect(inlineToHtml("~~删除~~")).toBe("<del>删除</del>");
  });

  it("inline code escapes content", () => {
    expect(inlineToHtml("`<script>`")).toBe("<code>&lt;script&gt;</code>");
  });

  it("link and image", () => {
    expect(inlineToHtml("[文本](https://a.b)")).toBe('<a href="https://a.b">文本</a>');
    expect(inlineToHtml("![图](x.png)")).toBe('<img src="x.png" alt="图">');
  });

  it("leaves existing HTML tags untouched", () => {
    expect(inlineToHtml("<strong>x</strong>")).toBe("<strong>x</strong>");
  });
});
