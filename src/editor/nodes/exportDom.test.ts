// 导出链路的端到端判据（2026-09-17）：**节点 → $generateHtmlFromNodes → 内联**。
//
// 为什么必须在这一层测：`lib/exportInline.test.ts` 只证明"替换逻辑对"，
// 但真正会坏的是**节点有没有留下线索**。这里用应用自己的节点类型走一遍导出，
// 两条断言都**在修复前会红**：
//   · 图片：老的 `exportDOM` 只写 `src`，没有 `data-export-hash` ⇒ 无法内联 ⇒ 导出件里是空图；
//   · 网址书签：老的 `exportDOM` 只输出 `<div data-webbookmark="url">url</div>`
//     ⇒ 标题/摘要/站点/缩略图全丢，就是用户说的"网页标签是空的"。
import { beforeAll, describe, expect, it } from "vitest";
import { $generateHtmlFromNodes } from "@lexical/html";
import { $createParagraphNode, $getRoot, createEditor } from "lexical";
import { $createImageNode, ImageNode } from "./ImageNode";
import { $createWebBookmarkNode, WebBookmarkNode } from "./WebBookmarkNode";
import { $createMermaidNode, MermaidNode } from "./MermaidNode";
import { EXPORT_HASH_ATTR, inlineExportMedia } from "../../lib/exportInline";
import { EXPORT_MERMAID_ATTR, renderExportMermaid } from "../../lib/exportMermaid";

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

// ⭐ 2026-10-08（台账 R123，owner：「导出 pdf 时，图形没有渲染出来」＋ 截图里流程图原样印成了代码）：
// mermaid 的判据加在**这一层**，理由与上面图片/书签完全相同 —— 真正会坏的是
// 「**节点有没有留下线索 ＋ 后处理有没有把它换掉**」。改之前这几条都会红：
// `MermaidNode.exportDOM` 只吐一个 `<pre>源码</pre>` ⇒ 导出件里必然是一段代码。
const FLOWCHART_SRC = "flowchart LR\n  A[开始] --> B[结束]";
const SEQUENCE_SRC = "sequenceDiagram\n  Alice->>Bob: hi";

function generateMermaidExportHtml(srcs: string[]): string {
  const editor = createEditor({
    namespace: "export-mermaid-test",
    nodes: [MermaidNode],
    onError: (e) => {
      throw e;
    },
  });
  editor.update(
    () => {
      const nodes = srcs.map((s) => $createMermaidNode(s));
      $getRoot().append(...nodes);
    },
    { discrete: true },
  );
  let html = "";
  editor.read(() => {
    html = $generateHtmlFromNodes(editor);
  });
  return html;
}

describe("导出的 HTML：mermaid 图块必须是「画出来的图」，不是一段源码", () => {
  // ⚠️ happy-dom **没有 SVG 布局** ⇒ `getBBox()` 恒为 0×0 ⇒ mermaid 的**时序图**渲染器会抛
  //    `svg element not in render tree`（实测：flowchart 不需要真测量，时序图需要）。
  //    这里给一个**合成**测量值（按字符数），只为让「时序图也走一遍真渲染」这条判据在本机跑得起来。
  //    ⛔ 它**不**影响下面那条真断言（有没有 `<svg>`）；也**不许**被当成「量过宽度」的读数。
  //    ⚠️ happy-dom 把 `getBBox` 挂在 `SVGTextElement` 的原型上（实测：`SVGElement.prototype` 上取不到）。
  beforeAll(() => {
    const proto = (globalThis as unknown as { SVGTextElement?: { prototype: Record<string, unknown> } }).SVGTextElement
      ?.prototype;
    if (!proto) return;
    proto.getBBox = function getBBox(this: { textContent?: string | null }) {
      const n = (this.textContent ?? "").length;
      return { x: 0, y: 0, width: Math.max(1, n * 8), height: 16 };
    };
  });

  const html = generateMermaidExportHtml([FLOWCHART_SRC, SEQUENCE_SRC]);

  it("节点留下了线索（没有它后处理无从下手 ⇒ 导出件里必然是一段代码）", () => {
    expect(html).toContain(EXPORT_MERMAID_ATTR);
    expect(html).toContain("flowchart LR");
  });

  it("★ 真渲染：flowchart 与**时序图**都换成 <svg>，源码不再出现（⛔ 规则不许只对 mindmap 成立）", async () => {
    const { html: out, report } = await renderExportMermaid(html);
    expect(report.rendered).toBe(2);
    expect(report.failed).toBe(0);
    expect((out.match(/<svg/g) ?? []).length).toBe(2);
    expect(out).not.toContain("<pre");
    expect(out).not.toContain("flowchart LR");
    expect(out).not.toContain("sequenceDiagram");
    expect(out).not.toContain(EXPORT_MERMAID_ATTR);
  }, 120000);

  it("★ 渲染失败 ⇒ **退回源码**（⛔ 不许导出空白 —— 那比现状更坏），且线索清掉、不反复重试", async () => {
    const { html: out, report } = await renderExportMermaid(html, {
      render: async () => {
        throw new Error("boom");
      },
    });
    expect(report.rendered).toBe(0);
    expect(report.failed).toBe(2);
    expect(out).toContain("flowchart LR");
    expect(out).toContain("sequenceDiagram");
    expect(out).toContain("<pre");
    expect(out).not.toContain("<svg");
    expect(out).not.toContain(EXPORT_MERMAID_ATTR);
  });

  it("只认带线索的那一个 <pre>：普通代码块一个字节都不许动", async () => {
    let calls = 0;
    const plain = "<p>正文</p><pre><code>const x = 1;</code></pre>";
    const { html: out, report } = await renderExportMermaid(plain, {
      render: async () => {
        calls += 1;
        return "<svg></svg>";
      },
    });
    expect(calls).toBe(0);
    expect(report.rendered).toBe(0);
    expect(out).toContain("<pre><code>const x = 1;</code></pre>");
  });
});
