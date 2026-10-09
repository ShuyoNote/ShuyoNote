import { beforeEach, describe, expect, it, vi } from "vitest";

// ⭐ **R167 判据**：`pages.importMarkdown` —— 整篇 md **一次**写成一页 ✓。
//   为什么强调"一次"：今天实测被写回的两页都是"建页 ＋ 多次追加"形状（19→3、18→3 块 ✗）；
//   而"只写一次"的页在编辑器里开着也**六分钟守恒** ✓（6→7 块是编辑器补的空段 ✓）。
const MD = ["# 架构笔记", "", "一段说明。", "", "```mermaid", "flowchart LR", "  A-->B", "```", "", "- 要点一", "- 要点二"].join("\n");
const store = new Map<string, string>();

vi.mock("../api", () => ({
  api: {
    createPage: vi.fn(async (a: { title: string; content_json: string; content_text: string }) => {
      store.set("new", a.content_json);
      return { id: "new", title: a.title, content_json: a.content_json, content_text: a.content_text };
    }),
    getPage: vi.fn(async (id: string) => {
      const json = store.get(id);
      return json === undefined ? null : { id, title: "演示", content_json: json, content_text: "" };
    }),
    savePage: vi.fn(async (a: { id: string; content_json: string; content_text: string }) => {
      store.set(a.id, a.content_json);
      return { id: a.id, title: "演示", content_json: a.content_json, content_text: a.content_text };
    }),
  },
}));

import { applyDraft } from "./apply";
import { markdownToPageContent } from "../mdPreview";
import { importMarkdownGuard } from "../docContent";

const blocksOf = (json: string) => JSON.parse(json).root.children as Array<{ type: string; language?: string }>;

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
});

describe("R167：整篇 Markdown 一次导入", () => {
  it("★ 围栏 ```mermaid ⇒ 出来的是**图块**（code+mermaid 或 mermaid），⛔ 不是纯段落 ✓", () => {
    const r = markdownToPageContent(MD) ? { ok: true as const, doc: markdownToPageContent(MD)! } : { ok: false as const, error: "解析失败" };
    expect(r.ok, JSON.stringify(r).slice(0, 200)).toBe(true);
    if (!r.ok) return;
    const json = r.doc.content_json;
    const hasMermaid = /"language":\s*"mermaid"/.test(json) || /"type":\s*"mermaid"/.test(json);
    expect(hasMermaid, "围栏 mermaid 必须变成图块 ✗（否则又成了「渲染不出来」那件事 ✓）").toBe(true);
  });

  it("★ 标题/列表 ⇒ 真的成了标题块与列表块（不是一整段 ✓）", () => {
    const doc = markdownToPageContent(MD);
    expect(doc, "md 必须能解析 ✓").toBeTruthy();
    if (!doc) return;
    const types = blocksOf(doc.content_json).map((b) => b.type);
    expect(types.some((t) => t.startsWith("shuyo-heading") || t === "heading"), `块类型里要有标题 ✓（实际 ${types.join(",")}）`).toBe(true);
    expect(types.some((t) => t.includes("list")), `块类型里要有列表 ✓（实际 ${types.join(",")}）`).toBe(true);
  });

  it("★ 三道闸：空 ⇒ 拒 ✓ ／ 含块级 HTML ⇒ 拒 ✓ ／ 超 200KB ⇒ 拒 ✓", () => {
    expect(importMarkdownGuard("   ").ok).toBe(false);
    expect(importMarkdownGuard("正常文字 <table><tr><td>x</td></tr></table>").ok).toBe(false);
    expect(importMarkdownGuard("x".repeat(200 * 1024 + 1)).ok).toBe(false);
  });

  it("★ 落库那条路：带 markdown 的草稿 ⇒ 建出来的页里就是图块 ＋ 标题 ＋ 列表 ✓", async () => {
    const res = await applyDraft({ kind: "create_page", args: { title: "导入的页", content_text: MD, markdown: true } });
    expect(res.ok, res.message).toBe(true);
    const types = blocksOf(store.get("new") ?? "").map((b) => b.type);
    const json = store.get("new") ?? "";
    expect(/mermaid/.test(json), "页里要有 mermaid 图块 ✓").toBe(true);
    expect(types.length, "块数应当多于 1（标题/段落/图/列表 ✓）").toBeGreaterThan(1);
  });
});
