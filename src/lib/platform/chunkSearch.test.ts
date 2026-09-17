// `search_chunks`（Web 侧）的**行为级**判据 —— 真 `SqliteStore`（真 sql.js、真 SQL）+ 真排序函数。
//
// 与 `derivedText.test.ts` 同一个理由：这条分支此前只有契约级覆盖（`check-web-commands` 保证
// "存在、参数 camelCase、形状对"），而它里面全是**跑起来才知道**的事情：两类 owner 能不能都命中、
// 排序稳不稳、回链三件套有没有带出来、缺表会不会炸。

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { SqliteStore, setWasmBytesProvider } from "../platform/sqliteStore";
import { CHUNK_VECTOR_BONUS, MAX_CHUNK_HITS, searchChunksVia } from "./chunkSearch";

// 真打分函数（页面检索那套）：这里只关心"它被用到、且分数可叠加"，
// 所以用一个**可预测**的实现 —— 用真实现会把这条判据变成"页面检索的判据"。
const fakeRank = (query: string, rows: { id: string; content_text: string }[]) =>
  rows
    .filter((r) => r.content_text.includes(query))
    .map((r) => ({ id: r.id, score: r.content_text.split(query).length - 1 }));

beforeAll(() => {
  const wasm = join(process.cwd(), "node_modules/sql.js/dist/sql-wasm.wasm");
  setWasmBytesProvider(async () => new Uint8Array(readFileSync(wasm)));
});

async function freshDb(withChunks = true) {
  const store = new SqliteStore({ load: async () => null, save: async () => {} });
  await store.init();
  if (withChunks) {
    store.run(`CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY, page_id TEXT, att_id TEXT, ord INTEGER NOT NULL,
      loc TEXT NOT NULL DEFAULT '', lang TEXT NOT NULL DEFAULT '', text TEXT NOT NULL, hash TEXT NOT NULL)`);
  }
  return store;
}

const addChunk = (store: SqliteStore, id: string, page: string | null, att: string | null, ord: number, loc: string, text: string, hash = "h") =>
  store.run(
    "INSERT INTO chunks (id, page_id, att_id, ord, loc, lang, text, hash) VALUES (?, ?, ?, ?, ?, '', ?, ?)",
    [id, page, att, ord, loc, text, hash],
  );

describe("search_chunks（web 侧逻辑，真 SQL）", () => {
  it("缺表 ⇒ 空数组（老库没迁移：不是错误，也不许抛）", async () => {
    const db = await freshDb(false);
    expect(searchChunksVia(db, "周报", 10, fakeRank as never)).toEqual([]);
  });

  it("空查询 ⇒ 空结果（绝不允许「返回全库」）", async () => {
    const db = await freshDb();
    addChunk(db, "page:p1#0", "p1", null, 0, "L1", "周报内容");
    expect(searchChunksVia(db, "   ", 10, fakeRank as never)).toEqual([]);
  });

  it("**两类 owner 都要命中**，且回链三件套（pageId/attId/loc）原样带出", async () => {
    const db = await freshDb();
    addChunk(db, "page:p1#0", "p1", null, 0, "L1", "周报：本周进展");
    addChunk(db, "att:a1#0", null, "a1", 0, "p.3", "扫描件里的周报");
    addChunk(db, "page:p2#0", "p2", null, 0, "L1", "与检索词无关");

    const hits = searchChunksVia(db, "周报", 10, fakeRank as never);
    expect(hits.map((h) => h.chunkId).sort()).toEqual(["att:a1#0", "page:p1#0"]);
    const pageHit = hits.find((h) => h.chunkId === "page:p1#0")!;
    expect(pageHit.pageId).toBe("p1");
    expect(pageHit.attId).toBeNull();
    expect(pageHit.loc).toBe("L1");
    expect(pageHit.snippet).toContain("周报");
    const attHit = hits.find((h) => h.chunkId === "att:a1#0")!;
    expect(attHit.attId).toBe("a1");
    expect(attHit.loc).toBe("p.3");
  });

  it("向量加分**有界**且只作用在已命中的块上：分数按注入的 bonus 精确叠加", async () => {
    const db = await freshDb();
    addChunk(db, "page:p1#0", "p1", null, 0, "L1", "周报 周报 周报"); // 关键词分 3
    addChunk(db, "page:p2#0", "p2", null, 0, "L1", "周报"); // 关键词分 1
    addChunk(db, "page:p3#0", "p3", null, 0, "L1", "无关内容"); // 不命中

    // 给得分低的那个块一个**有界**加分（= CHUNK_VECTOR_BONUS × 相似度），它应当反超
    const bonus = new Map([["page:p2#0", CHUNK_VECTOR_BONUS * 0.9]]);
    const hits = searchChunksVia(db, "周报", 10, fakeRank as never, bonus);
    expect(hits.map((h) => h.chunkId)).toEqual(["page:p2#0", "page:p1#0"]);
    expect(hits[0].score).toBeCloseTo(1 + CHUNK_VECTOR_BONUS * 0.9, 5);
    // 不命中的块即使有加分也**不该出现**（否则"检索"就变成了"纯向量相似"）
    expect(hits.map((h) => h.chunkId)).not.toContain("page:p3#0");
  });

  it("排序稳定：同分按 id 兜底（两次调用顺序必须一样）", async () => {
    const db = await freshDb();
    addChunk(db, "page:p2#0", "p2", null, 0, "L1", "周报");
    addChunk(db, "page:p1#0", "p1", null, 0, "L1", "周报");
    const a = searchChunksVia(db, "周报", 10, fakeRank as never).map((h) => h.chunkId);
    const b = searchChunksVia(db, "周报", 10, fakeRank as never).map((h) => h.chunkId);
    expect(a).toEqual(b);
    expect(a).toEqual(["page:p1#0", "page:p2#0"]);
  });

  it("limit 生效且被夹到上限", async () => {
    const db = await freshDb();
    for (let i = 0; i < 5; i++) addChunk(db, `page:p${i}#0`, `p${i}`, null, 0, "L1", "周报");
    expect(searchChunksVia(db, "周报", 2, fakeRank as never)).toHaveLength(2);
    expect(searchChunksVia(db, "周报", 9999, fakeRank as never)).toHaveLength(5);
    expect(MAX_CHUNK_HITS).toBe(100);
  });
});
