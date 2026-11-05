import { describe, expect, it } from "vitest";

import {
  assignPreviewHeadingIds,
  dirNameOf,
  fileNameOf,
  isMarkdownPath,
  markdownTitleFromText,
  resolveMarkdownAssetPath,
  stripTitleHeading,
} from "./markdownFile";

describe("外部 Markdown 打开 · 路径与标题", () => {
  it("① 只认 .md / .markdown（大小写不敏感）", () => {
    expect(isMarkdownPath("D:\\docs\\计划.md")).toBe(true);
    expect(isMarkdownPath("/tmp/plan.MARKDOWN")).toBe(true);
    expect(isMarkdownPath("D:\\docs\\计划.docx")).toBe(false);
  });

  it("② 文件名 / 目录：Windows 与 POSIX 都认", () => {
    expect(fileNameOf("D:\\docs\\计划.md")).toBe("计划.md");
    expect(fileNameOf("/tmp/计划.md")).toBe("计划.md");
    expect(dirNameOf("D:\\docs\\计划.md")).toBe("D:\\docs");
    expect(dirNameOf("/tmp/计划.md")).toBe("/tmp");
  });

  it("③ 标题优先 H1，其次文件名", () => {
    expect(markdownTitleFromText("# 季度计划\n\n正文", "D:\\x\\ignore.md")).toBe("季度计划");
    expect(markdownTitleFromText("正文", "D:\\x\\我的计划.md")).toBe("我的计划");
    expect(markdownTitleFromText("", "D:\\x\\README.markdown")).toBe("README");
  });

  it("③b 导入正文去掉被当作页面标题的那一行 H1（避免标题出现两次）", () => {
    expect(stripTitleHeading("# 季度计划\n\n正文", "D:\\x\\a.md")).toBe("\n正文");
    expect(stripTitleHeading("正文\n\n## 小节", "D:\\x\\a.md")).toBe("正文\n\n## 小节");
  });

  it("③c 目录：h1–h3 加 id，同名标题 id 不冲突", () => {
    const out = assignPreviewHeadingIds("<h1>标题</h1><h2>小节</h2><h2>小节</h2><h4>太深</h4>");
    expect(out.toc.map((t) => [t.level, t.text])).toEqual([
      [1, "标题"],
      [2, "小节"],
      [2, "小节"],
    ]);
    expect(new Set(out.toc.map((t) => t.id)).size).toBe(3);
    expect(out.html).toContain('id="md-preview-');
  });
});

describe("外部 Markdown 打开 · 相对图片", () => {
  it("④ 相对路径按 md 所在目录解析（含 .. 归一化）", () => {
    expect(resolveMarkdownAssetPath("D:\\docs", "images/a.png")).toBe("D:\\docs\\images\\a.png");
    expect(resolveMarkdownAssetPath("D:\\docs", "../assets/a.png")).toBe("D:\\assets\\a.png");
    expect(resolveMarkdownAssetPath("/home/u/docs", "./img/a%20b.png")).toBe("/home/u/docs/img/a b.png");
  });

  it("⑤ 外链 / data / attachment / 锚点不碰", () => {
    for (const ref of [
      "https://example.com/a.png",
      "data:image/png;base64,AAA",
      "attachment://abc",
      "blob:http://x/y",
      "#anchor",
      "//cdn.example.com/a.png",
    ]) {
      expect(resolveMarkdownAssetPath("D:\\docs", ref), ref).toBeNull();
    }
  });

  it("⑥ 绝对本地路径保留", () => {
    expect(resolveMarkdownAssetPath("D:\\docs", "D:\\pics\\a.png")).toBe("D:\\pics\\a.png");
    expect(resolveMarkdownAssetPath("/home/u/docs", "/srv/a.png")).toBe("\\srv\\a.png");
  });
});
