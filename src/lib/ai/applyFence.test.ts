import { beforeEach, describe, expect, it, vi } from "vitest";

// ⭐ **R166 判据**：外部写带 `fence` ⇒ **一整块** code 块（⛔ 不许按空行／换行拆开 ✗）。
//   现场（owner 2026-10-08）：MCP 建页原来只造段落 ⇒ 一段 ```mermaid 图源被拆成 **91 个段落** ✗
//   （围栏一块、每行一块）⇒ 没有任何一个块是完整的图 ⇒ 渲染不出来 ✓。
const SRC = "C4Context\n    title 系统上下文\n    Person(owner, \"主人\")\n    System(shuyo, \"ShuyoNote\")";
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

import { api } from "../api";
import { applyDraft } from "./apply";

type Blk = { type: string; language?: string; children?: Array<{ text?: string }> };
const blocksOf = (json: string) => JSON.parse(json).root.children as Blk[];
const textOf = (b: Blk) => (b.children ?? []).map((c) => c.text ?? "").join("");

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
});

describe("R166：带 fence 的写入必须是一整块 code 块", () => {
  it("★ 追加（append_block + fence）⇒ **恰好 1 个** code 块、language=mermaid、整段原样 ✓", async () => {
    store.set("p1", JSON.stringify({ root: { type: "root", version: 1, direction: "ltr", format: "", indent: 0, children: [] } }));
    const r = await applyDraft({ kind: "append_block", pageId: "p1", text: SRC, fence: "mermaid" });
    expect(r.ok, r.message).toBe(true);
    const codes = blocksOf(store.get("p1") ?? "").filter((b) => b.type === "code");
    expect(codes.length, `必须恰好一个 code 块 ✗（实际 ${codes.length} 个；⛔ 不许按行拆开 ✓）`).toBe(1);
    expect(codes[0].language).toBe("mermaid");
    expect(textOf(codes[0]), "整段源码必须**原样**在一个块里 ✓").toBe(SRC);
  });

  it("★ 新建（create_page + args.fence）⇒ 同样一整块 ✓", async () => {
    const r = await applyDraft({ kind: "create_page", args: { title: "架构图", content_text: SRC, fence: "mermaid" } });
    expect(r.ok, r.message).toBe(true);
    const blks = blocksOf(store.get("new") ?? "");
    expect(blks.length, "只该有一个块 ✓").toBe(1);
    expect(blks[0].type).toBe("code");
    expect(blks[0].language).toBe("mermaid");
    expect(textOf(blks[0])).toBe(SRC);
  });

  it("★ 不带 fence ⇒ 老路逐字不变（仍是段落、按空行分段 ✓）", async () => {
    store.set("p2", JSON.stringify({ root: { type: "root", version: 1, direction: "ltr", format: "", indent: 0, children: [] } }));
    await applyDraft({ kind: "append_block", pageId: "p2", text: "第一段\n\n第二段" });
    const blks = blocksOf(store.get("p2") ?? "");
    expect(blks.every((b) => b.type === "paragraph"), "不带 fence 不许变成 code 块 ✗").toBe(true);
    expect(blks.length).toBe(2);
    void api;
  });
});
