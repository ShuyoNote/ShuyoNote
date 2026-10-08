import { beforeEach, describe, expect, it, vi } from "vitest";

// ⭐ R151 现场：外部**并发**对同一页连发 20 次 append ⇒ 只落 4/20 ✗；**顺序** ⇒ 20/20 ✓。
//   这条判据在"真值"上跑：一个内存里的小 api，getPage/savePage 之间故意让出事件循环（模拟真网络 ✓）
//   ⇒ 没有串行区时必然互相覆盖 ⇒ 判据红 ✓；有串行区 ⇒ 20/20 ✓。
const store = new Map<string, string>();

vi.mock("../api", () => ({
  api: {
    getPage: vi.fn(async (id: string) => {
      await new Promise((r) => setTimeout(r, 1)); // 让出事件循环：并发才可能交错 ✓
      const text = store.get(id);
      if (text === undefined) return null;
      return { id, title: "演示", content_json: JSON.stringify({ root: { type: "root", version: 1, direction: "ltr", format: "", indent: 0, children: text ? [{ blockId: "b0", type: "paragraph", version: 1, direction: "ltr", format: "", indent: 0, style: "", children: [{ type: "text", text, format: "", style: "", mode: "normal", detail: 0, version: 1 }] }] : [] } }), content_text: text };
    }),
    savePage: vi.fn(async (args: { id: string; content_text?: string }) => {
      await new Promise((r) => setTimeout(r, 1));
      store.set(args.id, String(args.content_text ?? ""));
      return { id: args.id, title: "演示", content_json: "", content_text: String(args.content_text ?? "") };
    }),
  },
}));

import { api } from "../api";
import { applyDraft } from "./apply";
import { pendingKeyCount } from "../serializeByKey";

beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
});

describe("R151：同一页的并发追加不许互相覆盖", () => {
  it("★ 并发 20 次 ⇒ **20/20 都在** ✓（顺序行为不变 ✓）", async () => {
    const id = "p1";
    store.set(id, "原有的一段");

    const outs = await Promise.all(
      Array.from({ length: 20 }, (_, i) => applyDraft({ kind: "append_block", pageId: id, text: `追加第 ${i + 1} 段` })),
    );

    expect(outs.every((o) => o.ok), outs.map((o) => o.message).join(" ｜ ")).toBe(true);
    const final = store.get(id) ?? "";
    const present = Array.from({ length: 20 }, (_, i) => i + 1).filter((n) => final.includes(`追加第 ${n} 段`));
    expect(present.length, `只落了 ${present.length}/20 —— 并发覆盖了 ✗（最终内容：${final.slice(0, 80)}…）`).toBe(20);
    expect(final).toContain("原有的一段");

    // 队列跑完要清空 ✓（否则 Map 随页面数无限长）
    await new Promise((r) => setTimeout(r, 5));
    expect(pendingKeyCount()).toBe(0);
  });

  it("★ 顺序 20 次 ⇒ 行为与并发一致（20/20 ✓）", async () => {
    const id = "p2";
    store.set(id, "底稿");
    for (let i = 1; i <= 20; i++) {
      const r = await applyDraft({ kind: "append_block", pageId: id, text: `顺序第 ${i} 段` });
      expect(r.ok, r.message).toBe(true);
    }
    const final = store.get(id) ?? "";
    expect(Array.from({ length: 20 }, (_, i) => i + 1).every((n) => final.includes(`顺序第 ${n} 段`))).toBe(true);
  });

  it("不同页**互不等待** ✓（key 是页 ⇒ 不该串成一队）", async () => {
    store.set("a", "A");
    store.set("b", "B");
    const t0 = Date.now();
    await Promise.all([
      applyDraft({ kind: "append_block", pageId: "a", text: "甲" }),
      applyDraft({ kind: "append_block", pageId: "b", text: "乙" }),
    ]);
    // 每跳 2ms×2 次 ⇒ 串行要 ~8ms，并行 ~4ms；这里只断言"没被串成 4 跳"（宽松 ✓）
    expect(Date.now() - t0).toBeLessThan(50);
    expect(store.get("a")).toContain("甲");
    expect(store.get("b")).toContain("乙");
    void api;
  });
});
