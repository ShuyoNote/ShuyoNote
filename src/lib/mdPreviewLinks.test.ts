// 判据：只读 Markdown 预览的链接分类（2026-11-09）。
//   ① 外链只认 http/https/mailto（其它协议一律不代开）；
//   ② `#标题` 是文内跳转，不是文件；
//   ③ 相对路径 / 绝对路径都归「文件」，并拆掉 `?query` 与 `#anchor`；
//   ④ `#anchor` 找标题：文字全等优先，其次按 slug 近似；找不到返回 null（不假装成功）。
import { describe, expect, it } from "vitest";
import { classifyHref, findAnchorTarget, normalizeHeadingText } from "./mdPreviewLinks";

describe("classifyHref：链接判类", () => {
  it("① https / mailto 是外链", () => {
    expect(classifyHref("https://example.com/a?b=1")).toEqual({ kind: "external", href: "https://example.com/a?b=1" });
    expect(classifyHref("mailto:a@b.c")).toEqual({ kind: "external", href: "mailto:a@b.c" });
    expect(classifyHref("HTTPS://EXAMPLE.COM")).toEqual({ kind: "external", href: "HTTPS://EXAMPLE.COM" });
  });

  it("② #标题 是文内跳转（并做 URL 解码）", () => {
    expect(classifyHref("#需求分层模型")).toEqual({ kind: "anchor", anchor: "需求分层模型" });
    expect(classifyHref("#%E9%9C%80%E6%B1%82")).toEqual({ kind: "anchor", anchor: "需求" });
  });

  it("③ 相对路径 / 绝对路径 / 带锚点都归文件", () => {
    expect(classifyHref("../specs/a.md")).toEqual({ kind: "file", path: "../specs/a.md", anchor: null });
    expect(classifyHref("./a.md#section")).toEqual({ kind: "file", path: "./a.md", anchor: "section" });
    expect(classifyHref("D:/docs/a.md")).toEqual({ kind: "file", path: "D:/docs/a.md", anchor: null });
    expect(classifyHref("/home/u/a.md")).toEqual({ kind: "file", path: "/home/u/a.md", anchor: null });
    expect(classifyHref("附件/a%20b.pdf")).toEqual({ kind: "file", path: "附件/a b.pdf", anchor: null });
    expect(classifyHref("a.md?x=1#frag")).toEqual({ kind: "file", path: "a.md", anchor: "frag" });
  });

  it("④ 危险/不认识的协议一律不代开", () => {
    expect(classifyHref("javascript:alert(1)")).toEqual({ kind: "none" });
    expect(classifyHref("data:text/html,<b>x</b>")).toEqual({ kind: "none" });
    expect(classifyHref("ms-settings:network")).toEqual({ kind: "none" });
    expect(classifyHref("")).toEqual({ kind: "none" });
    expect(classifyHref(null)).toEqual({ kind: "none" });
  });

  it("⑤ 只有锚点没有路径 ⇒ 文内跳转（不产出一个空文件路径）", () => {
    expect(classifyHref("#")).toEqual({ kind: "anchor", anchor: "" });
  });
});

describe("findAnchorTarget：按标题文字找跳转目标", () => {
  it("文字全等（忽略大小写与空白差异）", () => {
    const root = document.createElement("div");
    root.innerHTML = "<h1>1. 需求分层模型（L0–L4）</h1><h2>其他</h2>";
    const hit = findAnchorTarget(root, "1.  需求分层模型（L0–L4）");
    expect(hit?.tagName).toBe("H1");
  });

  it("slug 近似（空白换 -）", () => {
    const root = document.createElement("div");
    root.innerHTML = "<h2>Some English Title</h2>";
    expect(findAnchorTarget(root, "some-english-title")?.tagName).toBe("H2");
  });

  it("找不到 ⇒ null（⛔ 不滚到顶上假装成功）", () => {
    const root = document.createElement("div");
    root.innerHTML = "<h1>甲</h1>";
    expect(findAnchorTarget(root, "乙")).toBeNull();
    expect(findAnchorTarget(null, "甲")).toBeNull();
    expect(findAnchorTarget(root, "")).toBeNull();
  });

  it("normalizeHeadingText 只折空白/大小写，不改标点", () => {
    expect(normalizeHeadingText("A  B\tC")).toBe("a b c");
    expect(normalizeHeadingText("（L0–L4）")).toBe("（l0–l4）");
  });
});
