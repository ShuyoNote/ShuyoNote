// 导出链路的端到端判据（2026-09-17）：**节点 → $generateHtmlFromNodes → 内联**。
//
// 为什么必须在这一层测：`lib/exportInline.test.ts` 只证明"替换逻辑对"，
// 但真正会坏的是**节点有没有留下线索**。这里用应用自己的节点类型走一遍导出，
// 两条断言都**在修复前会红**：
//   · 图片：老的 `exportDOM` 只写 `src`，没有 `data-export-hash` ⇒ 无法内联 ⇒ 导出件里是空图；
//   · 网址书签：老的 `exportDOM` 只输出 `<div data-webbookmark="url">url</div>`
//     ⇒ 标题/摘要/站点/缩略图全丢，就是用户说的"网页标签是空的"。
import { describe, expect, it } from "vitest";
import { $generateHtmlFromNodes } from "@lexical/html";
import { $createParagraphNode, $getRoot, createEditor } from "lexical";
import { $createImageNode, ImageNode } from "./ImageNode";
import { $createWebBookmarkNode, WebBookmarkNode } from "./WebBookmarkNode";
import { EXPORT_HASH_ATTR, inlineExportMedia } from "../../lib/exportInline";

const PNG_1PX = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function generateExportHtml(): string {
  // 桌面端的真实形态：图片的 src 是应用专有协议，内容寻址的 hash 才是真身份。
  const editor = createEditor({
    namespace: "export-test",
    nodes: [ImageNode, WebBookmarkNode],
    onError: (e) => {
      throw e;
    },
  });
  editor.update(
    () => {
      const p1 = $createParagraphNode();
      p1.append($createImageNode("attachment://localhost/C%3A/a.png", "一张图", false, null, null, "hash-img", "image/png"));

      const p2 = $createParagraphNode();
      p2.append(
        $createWebBookmarkNode("https://example.com/post", "被收藏的标题", "这是一段摘要", "example.com", "hash-thumb", "image/jpeg"),
      );

      $getRoot().append(p1, p2);
    },
    { discrete: true },
  );
  let html = "";
  editor.read(() => {
    html = $generateHtmlFromNodes(editor);
  });
  return html;
}

describe("导出的 HTML：图片与网址书签都要是「能带走的」", () => {
  const html = generateExportHtml();

  it("图片带着内容寻址线索（否则内联无从下手 ⇒ 导出件里是空图）", () => {
    expect(html).toContain(EXPORT_HASH_ATTR);
    expect(html).toContain("hash-img");
  });

  it("网址书签导出的是**卡片**：标题、摘要、站点、链接都在（老代码这里只有一串 URL）", () => {
    expect(html).toContain("被收藏的标题");
    expect(html).toContain("这是一段摘要");
    expect(html).toContain("example.com");
    expect(html).toContain('href="https://example.com/post"');
    expect(html).toContain("webbookmark-card");
  });

  it("书签缩略图也带线索（它同样是内容寻址附件，编辑期靠 attachmentPath+convertFileSrc 解析）", () => {
    expect(html).toContain("hash-thumb");
    expect(html).toContain("webbookmark-thumb");
  });

  it("内联之后，图片与缩略图都变成自包含的 data: URL —— 这才是「挪走也能看」", async () => {
    const { html: out, report } = await inlineExportMedia(html, {
      read: async () => PNG_1PX.buffer.slice(0) as ArrayBuffer,
    });
    expect(report.inlined).toBe(2); // 正文图 + 书签缩略图
    expect(out).toContain("data:image/png;base64,iVBORw0KGgo=");
    expect(out).toContain("data:image/jpeg;base64,iVBORw0KGgo=");
    expect(out).not.toContain("attachment://");
    expect(out).not.toContain(EXPORT_HASH_ATTR);
  });
});
