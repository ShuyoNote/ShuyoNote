// `chunks` 的读写 —— 与 `attachment_text` 同构（整体替换、幂等建表、可重建缓存）。
// 表结构见 `schema.ts`（单一事实源）；口径见方案 §6.1 / §8 P2。
//
// **为什么不做"增量更新"**：块的 id 是 `${ownerKey}#${ord}`，只要源文本没变，
// ord 就稳定 ⇒ id 稳定 ⇒ `chunk_embeddings` 里的向量**自然复用**（靠 hash 判同）。
// 源文本变了就整体重切重写、删掉多余的旧行 —— 这比"逐块 diff"简单，且不会留下孤儿向量。

import type { Chunk, ChunkOwner } from "./chunk";
import type { Awaitable, SqlRunner } from "./store";

export interface ChunkStore {
  ensureSchema(ddl: readonly string[]): Awaitable<void>;
  /** 整体替换某个 owner 的块（先删该 owner 的全部旧块）。 */
  replace(owner: ChunkOwner, chunks: readonly Chunk[]): Awaitable<void>;
  /** 按 ord 升序取回。 */
  chunksOf(owner: ChunkOwner): Awaitable<Chunk[]>;
  remove(owner: ChunkOwner): Awaitable<void>;
  stats(): Awaitable<{ chunks: number }>;
}

const COLS = "id, page_id, att_id, ord, loc, lang, text, hash";

/** owner 的 SQL 判据（页面块按 page_id、附件块按 att_id）。 */
function ownerWhere(owner: ChunkOwner): { sql: string; params: string[] } {
  return owner.kind === "attachment"
    ? { sql: "att_id = ?", params: [owner.attId] }
    : { sql: "page_id = ?", params: [owner.pageId] };
}

export function createChunkStore(db: SqlRunner): ChunkStore {
  const inTx = <T,>(fn: () => T): T => (db.transaction ? db.transaction(fn) : fn());

  return {
    ensureSchema(ddl) {
      for (const stmt of ddl) {
        if (db.exec) db.exec(stmt);
        else db.run(stmt);
      }
    },

    replace(owner, chunks) {
      // 一次事务、一次快照：批量插入逐条 persist 会退化成平方级开销（Web 侧踩过，§7）
      inTx(() => {
        const w = ownerWhere(owner);
        db.run(`DELETE FROM chunks WHERE ${w.sql}`, [...w.params]);
        for (const c of chunks) {
          db.run(
            `INSERT INTO chunks (${COLS}) VALUES (?,?,?,?,?,?,?,?)`,
            [
              c.id,
              c.pageId,
              c.attId,
              c.ord,
              c.loc,
              c.lang,
              c.text,
              c.hash,
            ] as unknown[],
          );
        }
      });
    },

    chunksOf(owner) {
      const w = ownerWhere(owner);
      const rows = db.query<{
        id: string;
        page_id: string | null;
        att_id: string | null;
        ord: number;
        loc: string;
        lang: string;
        text: string;
        hash: string;
      }>(`SELECT ${COLS} FROM chunks WHERE ${w.sql} ORDER BY ord ASC`, [...w.params]);
      return rows.map((r) => ({
        id: r.id,
        pageId: r.page_id,
        attId: r.att_id,
        ord: Number(r.ord),
        loc: r.loc,
        lang: r.lang,
        text: r.text,
        hash: r.hash,
      }));
    },

    remove(owner) {
      const w = ownerWhere(owner);
      db.run(`DELETE FROM chunks WHERE ${w.sql}`, [...w.params]);
    },

    stats() {
      const rows = db.query<{ n: number }>("SELECT COUNT(*) AS n FROM chunks");
      return { chunks: Number(rows[0]?.n ?? 0) };
    },
  };
}
