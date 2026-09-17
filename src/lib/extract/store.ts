// 派生文本的读写与失效 —— 契约见 docs/plans/2026-09-17-knowledge-base-ai-coverage-plan.md §15.5。
//
// 依赖一个**极小的 SQL 接口**（而不是直接依赖 sqliteStore / Tauri）：
//  - 桌面（Rust `db.rs`）与 Web（TS `sqliteStore.ts`）都要实现同一套语义；
//  - 注入式接口让这一层能在单测里跑**真 SQLite**（sql.js），而不是被一个"只会印证自己 SQL"的假对象骗过。

import type { ExtractedSegment } from "./types";

/** 存储层需要的最小能力。两个平台的适配器各自实现这三（四）个方法即可。 */
export interface SqlRunner {
  /** 执行一条写语句。 */
  run(sql: string, params?: readonly unknown[]): void;
  /** 查询并返回行。 */
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): T[];
  /** 执行多条 DDL（不含参数）。 */
  exec?(sql: string): void;
  /** 可选：把一组写操作包成事务。
   *  **不提供时 `replace()` 退化为"先删后插"**：若中途失败会留下部分行，且因为
   *  `src_hash` 已经是新的，后续 `needsExtract` 会误判为"已抽好"。
   *  所以**生产适配器应当提供事务**（sql.js 与 rusqlite 都有）。 */
  transaction?<T>(fn: () => T): T;
}

export interface AttachmentTextRow {
  att_id: string;
  extractor: string;
  seq: number;
  kind: string;
  text: string;
  loc: string;
  src_hash: string;
  updated_at: number;
}

export interface ExtractStat {
  extractor: string;
  rows: number;
  chars: number;
}

export interface AttachmentTextStore {
  /** 建表（幂等；DDL 来自 schema.ts 的单一事实源）。 */
  ensureSchema(ddl: readonly string[]): void;
  /** 该附件是否需要对**给定的这组**抽取器（重）抽。
   *  判据：任一抽取器在库中没有行，或**它的行带的是旧 hash** ⇒ 需要。 */
  needsExtract(attId: string, srcHash: string, extractorIds: readonly string[]): boolean;
  /** 整体替换 `(att_id, extractor)` 的行。**不做逐段 diff** —— 实现变更后段序不稳定，
   *  逐段 diff 会留下残段（§15.5）。 */
  replace(
    attId: string,
    extractorId: string,
    srcHash: string,
    segments: readonly ExtractedSegment[],
    now: number,
  ): void;
  /** 删掉该附件的全部派生行（附件被删，或内容变了要整体重抽）。 */
  removeAttachment(attId: string): void;
  /** 读回某附件的全部段，按 (extractor, seq) 稳定排序。 */
  segmentsOf(attId: string): AttachmentTextRow[];
  /** 观测用：按抽取器统计段数与字符数（`encrypted` 占比这类判断靠它）。 */
  stats(): ExtractStat[];
}

const COLS = "att_id, extractor, seq, kind, text, loc, src_hash, updated_at";

export function createAttachmentTextStore(db: SqlRunner): AttachmentTextStore {
  return {
    ensureSchema(ddl) {
      for (const stmt of ddl) {
        if (db.exec) db.exec(stmt);
        else db.run(stmt);
      }
    },

    needsExtract(attId, srcHash, extractorIds) {
      if (extractorIds.length === 0) return false;
      const rows = db.query<{ extractor: string; src_hash: string }>(
        "SELECT DISTINCT extractor, src_hash FROM attachment_text WHERE att_id = ?",
        [attId],
      );
      // 每个抽取器都必须有行，且**所有**行都带当前 hash。
      // （用"所有行"而不是"任一行"：万一出现过部分写入，宁可重抽一次也不要把残段当好的。）
      const ok = new Set(
        rows.filter((r) => r.src_hash === srcHash).map((r) => r.extractor),
      );
      if (rows.some((r) => r.src_hash !== srcHash)) return true;
      return extractorIds.some((id) => !ok.has(id));
    },

    replace(attId, extractorId, srcHash, segments, now) {
      const write = () => {
        db.run("DELETE FROM attachment_text WHERE att_id = ? AND extractor = ?", [
          attId,
          extractorId,
        ]);
        for (let seq = 0; seq < segments.length; seq++) {
          const s = segments[seq];
          db.run(
            `INSERT INTO attachment_text (${COLS}) VALUES (?,?,?,?,?,?,?,?)`,
            [attId, extractorId, seq, s.kind, s.text, s.loc, srcHash, now],
          );
        }
      };
      if (db.transaction) db.transaction(write);
      else write();
    },

    removeAttachment(attId) {
      db.run("DELETE FROM attachment_text WHERE att_id = ?", [attId]);
    },

    segmentsOf(attId) {
      return db.query<AttachmentTextRow>(
        `SELECT ${COLS} FROM attachment_text WHERE att_id = ? ORDER BY extractor, seq`,
        [attId],
      );
    },

    stats() {
      return db.query<ExtractStat>(
        `SELECT extractor,
                COUNT(*) AS rows,
                COALESCE(SUM(LENGTH(text)), 0) AS chars
           FROM attachment_text
          GROUP BY extractor
          ORDER BY extractor`,
      );
    },
  };
}
