// 页面侧分块的判据 —— 用**假平台 + 真 sqlite**（假 store 会造出假结论，今天已经踩过一次）。

import { readFileSync } from "node:fs";
import { join } from "node:path";

import initSqlJs from "sql.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { DERIVED_SCHEMA_DDL } from "../extract/schema";
import { createChunkStore } from "../extract/chunkStore";
import { setWasmBytesProvider } from "./sqliteStore";
import type { SqlRunner } from "../extract/store";
import type { Platform } from "./types";
import { setPlatform } from "./index";
import { chunkPage, chunkPages, removePageChunks } from "./pageChunks";

beforeAll(() => {
  const bytes = readFileSync(join(process.cwd(), "node_modules/sql.js/dist/sql-wasm.wasm"));
  setWasmBytesProvider(async () => new Uint8Array(bytes));
});

interface SqlJsDatabase {
  run(sql: string, params?: unknown[]): void;
  exec(sql: string): { values: unknown[][] }[];
  prepare(sql: string): {
    bind(p?: unknown[]): void;
    step(): boolean;
    getAsObject(): Record<string, unknown>;
    free(): void;
  };
}

async function realStore() {
  const SQL = await initSqlJs();
  const db = new SQL.Database() as unknown as SqlJsDatabase;
  const runner: SqlRunner = {
    run: (sql, params = []) => db.run(sql, [...params]),
    query: <T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) => {
      const stmt = db.prepare(sql);
      stmt.bind([...params]);
      const out: T[] = [];
      while (stmt.step()) out.push(stmt.getAsObject() as T);
      stmt.free();
      return out;
    },
  };
  const store = createChunkStore(runner);
  (await store.ensureSchema(DERIVED_SCHEMA_DDL));
  return store;
}

/** 假平台：页面表由用例给；`get_page` 也记调用次数（用来验"没变就不写"之外的另一半）。 */
function platformWithPages(pages: Record<string, { title: string; content_text: string }>, calls?: string[]) {
  return {
    executor: {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd !== "get_page") throw new Error(`意外命令 ${cmd}`);
        const id = String(args?.id ?? "");
        calls?.push(id);
        const p = pages[id];
        if (!p) throw new Error(`页面不存在: ${id}`);
        return { id, title: p.title, content_text: p.content_text };
      },
    },
  } as unknown as Platform;
}

function install(p: Partial<Platform>) {
  setPlatform({ ...(p as Platform) } as Platform);
}

afterEach(() => {
  install({ executor: { invoke: async () => { throw new Error("未提供"); } } } as Partial<Platform>);
});

const longBody = (n: number) =>
  Array.from({ length: n }, (_, i) => `第${i}条讲了预算与差旅报销的具体规定。`).join("");

describe("页面侧分块（P2 的另一半：知识库主体是页面，不是附件）", () => {
  it("读 `get_page` 的正文 → 切块 → 落库；标题挂在第一块", async () => {
    install(platformWithPages({ p1: { title: "差旅报销制度", content_text: longBody(120) } }));
    const store = await realStore();

    const r = await chunkPage("p1", store);
    expect(r.changed).toBe(true);
    expect(r.chunks).toBeGreaterThan(1);

    const rows = (await store.chunksOf({ kind: "page", pageId: "p1" }));
    expect(rows).toHaveLength(r.chunks);
    expect(rows[0].text.startsWith("差旅报销制度\n")).toBe(true);
    expect(rows[1].text.includes("差旅报销制度")).toBe(false); // 标题只挂第一块
    expect(rows.every((c) => c.pageId === "p1" && c.attId === null)).toBe(true);
  });

  it("**内容没变 ⇒ 不写库**（分块是纯运算，写库才贵 —— Web 侧每条写都触发全库快照）", async () => {
    install(platformWithPages({ p1: { title: "T", content_text: longBody(60) } }));
    const store = await realStore();

    const first = await chunkPage("p1", store);
    expect(first.changed).toBe(true);
    const snapshot = (await store.chunksOf({ kind: "page", pageId: "p1" })).map((c) => c.hash);

    const second = await chunkPage("p1", store);
    expect(second.changed).toBe(false); // 没变 ⇒ 跳过写
    expect(second.chunks).toBe(first.chunks);
    // 而且**行本身没被动过**（不是"写了但内容一样"）
    expect((await store.chunksOf({ kind: "page", pageId: "p1" })).map((c) => c.hash)).toEqual(snapshot);
  });

  it("**内容变了 ⇒ 重切并整体替换，不留孤儿块**", async () => {
    const pages = { p1: { title: "T", content_text: longBody(120) } };
    install(platformWithPages(pages));
    const store = await realStore();
    const many = (await chunkPage("p1", store)).chunks;
    expect(many).toBeGreaterThan(1);

    pages.p1.content_text = "只剩一句话了。";
    const after = await chunkPage("p1", store);
    expect(after.changed).toBe(true);
    expect(after.chunks).toBe(1);
    expect((await store.chunksOf({ kind: "page", pageId: "p1" }))).toHaveLength(1);
  });

  it("**页面被清空 ⇒ 块也被清掉**（不留下「检索得到但页面已空」的块）", async () => {
    const pages = { p1: { title: "T", content_text: longBody(60) } };
    install(platformWithPages(pages));
    const store = await realStore();
    await chunkPage("p1", store);
    expect((await store.chunksOf({ kind: "page", pageId: "p1" })).length).toBeGreaterThan(0);

    pages.p1.content_text = "   ";
    const r = await chunkPage("p1", store);
    expect(r).toMatchObject({ chunks: 0, changed: true });
    expect((await store.chunksOf({ kind: "page", pageId: "p1" }))).toHaveLength(0);
  });

  it("`title` 可由调用方覆盖（刚改过标题、还没写回库里时用）", async () => {
    install(platformWithPages({ p1: { title: "旧标题", content_text: "正文。 " } }));
    const store = await realStore();
    await chunkPage("p1", store, { title: "新标题" });
    expect((await store.chunksOf({ kind: "page", pageId: "p1" }))[0].text.startsWith("新标题\n")).toBe(true);
  });

  it("批量：顺序执行、互不干扰；列表里的页面都会各自落库", async () => {
    const calls: string[] = [];
    install(platformWithPages({
      a: { title: "A", content_text: "甲文。" },
      b: { title: "B", content_text: "乙文。" },
    }, calls));
    const store = await realStore();

    const out = await chunkPages(["a", "b"], store);
    expect(calls).toEqual(["a", "b"]); // 顺序，不是并发（避免一次打爆）
    expect(out.map((r) => r.pageId)).toEqual(["a", "b"]);
    expect((await store.chunksOf({ kind: "page", pageId: "a" }))[0].text).toContain("甲文");
    expect((await store.chunksOf({ kind: "page", pageId: "b" }))[0].text).toContain("乙文");
  });

  it("`removePageChunks` 清掉该页面的块（删页时用，防孤儿块）", async () => {
    install(platformWithPages({ p1: { title: "T", content_text: longBody(60) } }));
    const store = await realStore();
    await chunkPage("p1", store);
    removePageChunks("p1", store);
    expect((await store.chunksOf({ kind: "page", pageId: "p1" }))).toHaveLength(0);
  });

  it("页面不存在时**抛出**（调用方的错，不该被伪装成「切出 0 块」）", async () => {
    install(platformWithPages({}));
    const store = await realStore();
    await expect(chunkPage("nope", store)).rejects.toThrow("页面不存在");
  });

  it("**附件块与页面块互不干扰**（同一张表、两套 owner）", async () => {
    install(platformWithPages({ p1: { title: "P", content_text: "页面正文。" } }));
    const store = await realStore();
    // 手工塞一个附件块（形状与 extractAttachment 落的一致）
    store.replace({ kind: "attachment", attId: "p1" }, [
      { id: "att:p1#0000", pageId: null, attId: "p1", ord: 0, loc: "", lang: "zh", text: "附件文本。", hash: "x" },
    ]);
    await chunkPage("p1", store);

    expect((await store.chunksOf({ kind: "attachment", attId: "p1" }))[0].text).toBe("附件文本。");
    expect((await store.chunksOf({ kind: "page", pageId: "p1" }))[0].text).toContain("页面正文");
  });
});
