// 「正文预览」那条链：Markdown → HTML（复用导入那套 `mdToHtml`）→ DOMPurify。
//
// ⚠️⚠️ **一条环境事实（2026-09-21 实测，别再被它骗一次）**：
//   `happy-dom` 里 **DOMPurify 等于没做事** —— 用**默认配置** `sanitize('<script>alert(1)</script>')`
//   也原样返回（只有"最外层元素的标签被吃掉"这个怪相）。所以：
//     · 本文件**不**用 vitest 断言"消毒生效"（那会是一条永远绿的假判据）；
//     · 消毒这件事由**真浏览器**读数钉：同日真 Edge(Chromium) + 真 DOMPurify + 本文件的
//       `PREVIEW_SANITIZE_CONFIG`，`<script>` / `<iframe>` / `onerror` / `javascript:` **全清掉**，
//       `<h1>/<h2>/<hr>/<li>/<blockquote>` 全都在，链接被补上 `target=_blank rel=noreferrer`；
//     · 这里改成钉**白名单本身**（配置里不许出现危险标签/属性）—— 这才是本地能判的那一半。
//   这也意味着：以后凡是"靠 happy-dom 断言消毒"的判据都是假的，要么去真浏览器，要么像这里一样钉配置。
import { describe, expect, it } from "vitest";
import { PREVIEW_SANITIZE_CONFIG, markdownPreviewHtml } from "./mdPreviewHtml";

describe("markdownPreviewHtml（发布前清单的正文预览）", () => {
  it("Markdown 真的渲染成元素：标题 / 分隔线 / 列表 / 引用 / 行内代码", () => {
    const html = markdownPreviewHtml(
      "开场\n\n# 今日小记\n\n---\n\n## 三件最有价值的事\n\n- 完成了：\n- 推进了：\n\n> 一句话总结今天。\n\n用 `code` 与 **加粗**。",
    );
    expect(html).toContain("<h1>今日小记</h1>");
    expect(html).toContain("<hr>");
    expect(html).toContain("<h2>三件最有价值的事</h2>");
    expect(html).toContain("<li>完成了：</li>");
    expect(html).toContain("<blockquote>一句话总结今天。</blockquote>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<strong>加粗</strong>");
    // 源码标记不该漏到渲染结果里（这正是用户抱怨"不友好"的那点）
    expect(html).not.toContain("## ");
  });

  it("图片/链接照 Markdown 语义出来", () => {
    const html = markdownPreviewHtml(
      "![图](attachment://localhost/C%3A/hash-a.png)\n\n[数友社区](https://community.shuyo.cn)",
    );
    expect(html).toContain('src="attachment://localhost/C%3A/hash-a.png"');
    expect(html).toContain('href="https://community.shuyo.cn"');
  });

  it("白名单本身不许放危险标签/属性（本地能判的那一半；清没清干净由真浏览器读数钉）", () => {
    for (const bad of ["script", "iframe", "object", "embed", "style", "link", "base", "form", "input", "svg"]) {
      expect(PREVIEW_SANITIZE_CONFIG.ALLOWED_TAGS).not.toContain(bad);
    }
    for (const bad of ["onerror", "onload", "onclick", "style", "xlink:href"]) {
      expect(PREVIEW_SANITIZE_CONFIG.ALLOWED_ATTR).not.toContain(bad);
    }
    // data-* 属性不开（邮件那条同口径：没必要给一条能塞任意数据的通道）
    expect(PREVIEW_SANITIZE_CONFIG.ALLOW_DATA_ATTR).toBe(false);
  });

  it("空正文返回空串（清单自己会显示「正文是空的」）", () => {
    expect(markdownPreviewHtml("")).toBe("");
    expect(markdownPreviewHtml("   \n  ")).toBe("");
  });
});
