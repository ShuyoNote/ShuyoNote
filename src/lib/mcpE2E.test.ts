// B2-补遗-3：**apply 层 e2e**（注入 mock api，不碰 UI/真库）。
//
// 钉的是"草稿 → apply → 读回"这条链：块写后顶层块/块 id/锚点数、附件 detach/delete 的可见性、
// 数据库行写读回、锁着的空间写失败要如实报错。Rust 侧的引用检查/权限/幂等/审计判据在
// `plugins.rs` / `mcp_host.rs` 里另测（这里不重复造一个 Rust 语义）。
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── 内存假 api（只实现 apply 用到的那些命令）──────────────────────────────────
const store = vi.hoisted(() => {
  type P = Record<string, unknown> & { id: string; title: string; content_json: string; content_text: string; updated_at: number; kind: string; parent_id: string | null };
  type A = { id: string; page_id: string | null; name: string; hash: string; size: number };
  return {
    pages: new Map<string, P>(),
    attachments: new Map<string, A>(),
    props: new Map<string, string>(),
    lockedSpace: false,
    draftStates: [] as Array<[string, string]>,
    saveCalls: [] as Array<Record<string, unknown>>,
    reset() {
      store.pages.clear();
      store.attachments.clear();
      store.props.clear();
      store.lockedSpace = false;
      store.draftStates.length = 0;
      store.saveCalls.length = 0;
    },
    addPage(p: Partial<P> & { id: string }) {
      store.pages.set(p.id, {
        title: "",
        content_json: '{"root":{"type":"root","children":[]}}',
        content_text: "",
        updated_at: 1,
        kind: "page",
        parent_id: null,
        ...p,
      } as P);
    },
    touch(id: string) {
      const p = store.pages.get(id);
      if (p) p.updated_at += 1;
    },
  };
});

vi.mock("./api", () => ({
  api: {
    getPage: async (id: string) => store.pages.get(id) ?? null,
    savePage: async (args: Record<string, unknown>) => {
      if (store.lockedSpace) throw new Error("空间已锁定：请先解锁");
      const p = store.pages.get(String(args.id));
      if (!p) throw new Error("页面不存在");
      store.saveCalls.push({ ...args });
      Object.assign(p, args);
      store.touch(p.id);
      return p;
    },
    createPage: async (args: Record<string, unknown>) => {
      if (store.lockedSpace) throw new Error("空间已锁定：请先解锁");
      const id = `new-${store.pages.size + 1}-${Math.random().toString(36).slice(2, 6)}`;
      const p = {
        id,
        title: String(args.title ?? ""),
        content_json: String(args.content_json ?? '{"root":{"type":"root","children":[]}}'),
        content_text: String(args.content_text ?? ""),
        updated_at: 1,
        kind: "page",
        parent_id: (args.parent_id as string | null) ?? null,
      };
      store.pages.set(id, p);
      return p;
    },
    deletePage: async (id: string) => {
      store.pages.delete(id);
    },
    restorePage: async () => undefined,
    detachAttachment: async (id: string) => {
      const a = store.attachments.get(id);
      if (!a) throw new Error("附件不存在");
      a.page_id = null;
    },
    removeAttachment: async (id: string) => {
      store.attachments.delete(id);
    },
    moveAttachment: async () => undefined,
    renameAttachment: async () => undefined,
    setPageProp: async (args: { page_id: string; attr_id: string; value: string }) => {
      store.props.set(`${args.page_id}|${args.attr_id}`, args.value);
    },
    removePageProp: async (args: { pageId: string; attrId: string }) => {
      store.props.delete(`${args.pageId}|${args.attrId}`);
    },
    listTemplates: async () => [],
    listTags: async () => [],
    removeTag: async () => undefined,
    mcpDraftState: async (draftId: string, state: string) => { store.draftStates.push([draftId, state]); },
    listPageAttachments: async (pageId: string | null) =>
      [...store.attachments.values()].filter((a) => a.page_id === pageId),
  },
}));

vi.mock("./platform", () => ({
  platform: { event: { listen: vi.fn(async () => () => {}) }, derivedStores: undefined },
}));

import { applyDraft } from "./ai/apply";
import { pageRev } from "./capabilities/pageAnchors";
import { docJsonOfPage } from "./docContent";
import { runFrontendTool } from "./mcpFrontendTools";

const topChildren = (p: { content_json?: string | null }) =>
  (JSON.parse(docJsonOfPage(p)) as { root?: { children?: Array<Record<string, unknown>> } }).root?.children ?? [];

async function revOf(pageId: string): Promise<string> {
  const p = store.pages.get(pageId)!;
  const r = await pageRev(p.updated_at, p.content_json);
  if (!r) throw new Error("rev 算不出");
  return r;
}

function docOf(blocks: Array<{ id: string; text: string }>): string {
  return JSON.stringify({
    root: {
      type: "root",
      children: blocks.map((b) => ({
        type: "paragraph",
        blockId: b.id,
        children: [{ type: "text", text: b.text }],
      })),
    },
  });
}

const textOf = (p: { content_json?: string | null }) => JSON.stringify(topChildren(p));

/** 锚点数（`<!-- b:… -->` 的出现次数）—— 必须等于顶层块数。 */
async function anchorsOf(pageId: string): Promise<number> {
  const r = await runFrontendTool("markdown.render", { pageId }, {
    getPage: async (id) => store.pages.get(id) as never,
    listPageAttachments: async () => [],
    readAttachmentBytes: async () => new Uint8Array(),
    getActiveWorkspaceId: async () => "s1",
  });
  const md = JSON.parse(new TextDecoder().decode(r.bytes)).markdown as string;
  return (md.match(/<!-- b:/g) ?? []).length;
}

beforeEach(() => store.reset());

describe("B2-补遗-3 · blocks.* e2e（apply → 读回）", () => {
  it("patch：目标块 id 不变、其余 id 不变、锚点数=顶层块数", async () => {
    store.addPage({ id: "p1", content_json: docOf([{ id: "b1", text: "旧一" }, { id: "b2", text: "旧二" }]) });
    const r = await applyDraft({
      kind: "blocks_patch",
      pageId: "p1",
      blockId: "b1",
      markdown: "新的第一段",
      expectedRev: await revOf("p1"),
    });
    expect(r.ok, r.message).toBe(true);
    const p = store.pages.get("p1")!;
    const kids = topChildren(p);
    expect(kids.map((k) => k.blockId)).toEqual(["b1", "b2"]);
    expect(await anchorsOf("p1")).toBe(kids.length);
    expect(JSON.stringify(kids[0])).toContain("新的第一段");
    expect(JSON.stringify(kids[1])).toContain("旧二");
    expect(textOf(p)).toContain("新的第一段");
  });

  it("insert：返回的 newBlockId 立刻可用于下一次 patch；delete 后无空块", async () => {
    store.addPage({ id: "p1", content_json: docOf([{ id: "b1", text: "一" }]) });
    const r = await applyDraft({
      kind: "blocks_insert",
      pageId: "p1",
      afterBlockId: "b1",
      markdown: "插入段",
      newBlockId: "nb1",
      expectedRev: await revOf("p1"),
    });
    expect(r.ok, r.message).toBe(true);
    expect(topChildren(store.pages.get("p1")!).map((k) => k.blockId)).toEqual(["b1", "nb1"]);
    expect(await anchorsOf("p1")).toBe(2);
    // newBlockId 立刻可用于 patch
    const r2 = await applyDraft({
      kind: "blocks_patch",
      pageId: "p1",
      blockId: "nb1",
      markdown: "改插入段",
      expectedRev: await revOf("p1"),
    });
    expect(r2.ok, r2.message).toBe(true);
    const kids = topChildren(store.pages.get("p1")!);
    expect(kids.map((k) => k.blockId)).toEqual(["b1", "nb1"]);
    expect(JSON.stringify(kids[1])).toContain("改插入段");
    // delete 后只剩一块，且没有空块残留
    const r3 = await applyDraft({ kind: "blocks_delete", pageId: "p1", blockId: "nb1", expectedRev: await revOf("p1") });
    expect(r3.ok, r3.message).toBe(true);
    expect(topChildren(store.pages.get("p1")!).length).toBe(1);
    expect(await anchorsOf("p1")).toBe(1);
  });

  it("锁着的空间：apply 明确失败（不静默成功）", async () => {
    store.addPage({ id: "p1", content_json: docOf([{ id: "b1", text: "一" }]) });
    store.lockedSpace = true;
    await expect(
      applyDraft({
        kind: "blocks_patch",
        pageId: "p1",
        blockId: "b1",
        markdown: "x",
        expectedRev: await revOf("p1"),
      }),
    ).rejects.toThrow(/锁定/);
  });
});

describe("B2-补遗-3 · files.detach / files.delete e2e（apply 后可见性）", () => {
  it("detach：页清单不可见、孤儿清单可见、sha/字节指纹不变", async () => {
    store.addPage({ id: "p1" });
    store.attachments.set("a1", { id: "a1", page_id: "p1", name: "r.pdf", hash: "h".repeat(64), size: 3 });
    const r = await applyDraft({ kind: "detach_attachment", attId: "a1" });
    expect(r.ok, r.message).toBe(true);
    const a = store.attachments.get("a1")!;
    expect(a.page_id).toBeNull();
    expect(a.hash).toBe("h".repeat(64));
    expect([...store.attachments.values()].filter((x) => x.page_id === "p1")).toEqual([]);
    expect([...store.attachments.values()].filter((x) => x.page_id === null).map((x) => x.id)).toEqual(["a1"]);
  });

  it("delete：apply 后页清单与孤儿清单都不再有它（引用检查在 Rust 能力层判）", async () => {
    store.addPage({ id: "p1" });
    store.attachments.set("a1", { id: "a1", page_id: "p1", name: "r.pdf", hash: "h".repeat(64), size: 3 });
    const r = await applyDraft({ kind: "delete_attachment", attId: "a1" });
    expect(r.ok, r.message).toBe(true);
    expect(store.attachments.size).toBe(0);
  });
});

describe("B2-补遗-3 · db.rows_write/delete e2e（apply → 读回）", () => {
  it("写行：total/值正确；删行：少一行；行都是数据库页的子页", async () => {
    store.addPage({ id: "db1", kind: "database", title: "表" });
    store.addPage({ id: "r1", parent_id: "db1", title: "行一" });
    store.props.set("r1|c-name", "甲");
    const r = await applyDraft({
      kind: "db_rows_write",
      pageId: "db1",
      rows: [
        { rowId: "r1", title: "行一改", props: [{ attrId: "c-name", value: "乙" }] },
        { title: "行二", props: [{ attrId: "c-name", value: "丙" }] },
      ],
      expectedRev: await revOf("db1"),
    });
    expect(r.ok, r.message).toBe(true);
    const rows = [...store.pages.values()].filter((x) => x.parent_id === "db1");
    expect(rows.length).toBe(2);
    const byTitle = Object.fromEntries(rows.map((x) => [x.title, store.props.get(`${x.id}|c-name`)]));
    expect(byTitle["行一改"]).toBe("乙");
    expect(byTitle["行二"]).toBe("丙");
    // 删一行 ⇒ total 少 1
    const second = rows.find((x) => x.title === "行二")!;
    const rd = await applyDraft({
      kind: "db_rows_delete",
      pageId: "db1",
      rowIds: [second.id],
      expectedRev: await revOf("db1"),
    });
    expect(rd.ok, rd.message).toBe(true);
    expect([...store.pages.values()].filter((x) => x.parent_id === "db1").length).toBe(1);
  });
});


describe("一致性批 · blocks.insert 跨空间 apply e2e", () => {
  it("savePage 收到目标 spaceId、children 含新块；当前空间 savePage 未被调", async () => {
    store.addPage({ id: "p1", content_json: docOf([{ id: "b1", text: "旧" }]) });
    const r = await applyDraft({
      kind: "blocks_insert",
      pageId: "p1",
      afterBlockId: "b1",
      markdown: "新块",
      newBlockId: "nb1",
      spaceId: "s2",
    });
    expect(r.ok, r.message).toBe(true);
    expect(store.saveCalls.length).toBe(1);
    const call = store.saveCalls[0];
    expect(call.spaceId).toBe("s2");
    expect(String(call.content_json)).toContain("nb1");
    expect(store.saveCalls.every((c) => c.spaceId === "s2")).toBe(true);
    expect(store.saveCalls.some((c) => !c.spaceId)).toBe(false);
  });
});
