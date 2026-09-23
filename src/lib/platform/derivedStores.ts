// 桌面侧的派生层 store：把两个 store 的**语义**实现成"攒一条 op → 走 `derived_apply`/`derived_query`"。
//
// ## 它在整条链里的位置
//
//   `indexPage` / `extractAttachment`（编排，平台无关）
//        └── `AttachmentTextStore` / `ChunkStore`   ← 本文件（桌面实现）
//                 └── `derived_apply` / `derived_query`（Rust 运输层，只搬不决定）
//
// Web 侧对应的是 `SqliteStore.derivedTextStore()` + `createChunkStore(runner)`（同步，直接跑 sql.js）。
// 两边**同一套编排代码**，差别只在这一个实现上 —— 这正是把 store 接口放宽成 `Awaitable<T>` 的目的。
//
// ## 三条刻意的取舍
//
// 1. **`ensureSchema` 在桌面是 no-op**：桌面的三张表由 Rust `db::migrate` 建（`DERIVED_SCHEMA_DDL`
//    只是 TS 侧的单一事实源，Rust 侧照抄并有一致性判据）。TS 这边再建一次既没权限也没必要。
// 2. **不做本地缓存/批量攒批**：一次 store 调用 = 一次命令调用（`replace` 的"先删后插"在 Rust 侧
//    就是**一个事务**，这正是 `DerivedOp` 按"整体替换"而不是"逐行"设计的原因）。
// 3. **`needsExtract` 的判定与同步实现逐条对齐**（读回 `(extractor, src_hash)` 后按同一条规则算），
//    并有判据拿"同样的行"同时问两个实现，两边答案必须相同 —— 防的就是"两份实现在这里漂"。

import type { Chunk, ChunkOwner } from "../extract/chunk";
import type { ChunkStore } from "../extract/chunkStore";
import type { AttachmentTextRow, AttachmentTextStore, ExtractStat } from "../extract/store";
import { storedCoverageFrom } from "../extract/store";
import type { ExtractCoverage, ExtractedSegment } from "../extract/types";
import { applyOps, queryRows, type DerivedChunk, type DerivedInvoker, type DerivedOwner } from "./derivedTransport";

/** `ChunkOwner`（TS 侧）→ `DerivedOwner`（线上形状）—— 两个类型同形，转换写成一处免得两边漂。 */
function toOwner(owner: ChunkOwner): DerivedOwner {
  return owner.kind === "attachment" ? { kind: "attachment", attId: owner.attId } : { kind: "page", pageId: owner.pageId };
}

/** Rust 侧 `chunkRows` 返回的行（字段名与 `Chunk` 一致，省一层映射）。 */
type ChunkRowJson = Chunk & Record<string, unknown>;

/** Rust 侧 `attachmentTextSegments` 返回的行（列名是 snake_case，与 TS 的 `AttachmentTextRow` 同形）。 */
type SegmentRowJson = AttachmentTextRow;

/** Rust 侧 `attachmentTextStats` 返回的行。 */
type StatRowJson = ExtractStat;

function toChunk(c: Chunk): DerivedChunk {
  return {
    id: c.id,
    pageId: c.pageId,
    attId: c.attId,
    ord: c.ord,
    loc: c.loc,
    lang: c.lang,
    text: c.text,
    hash: c.hash,
  };
}

/**
 * 与同步实现**逐条对齐**的"要不要重抽"判定（`extract/store.ts::needsExtract` 的同一套规则）：
 * 任一行的 hash 与当前不符 ⇒ 要；否则每个抽取器都必须有行。
 *
 * ⚠️ 抽成纯函数是为了能被判据**同时**作用在两个实现上（喂同样的行，答案必须相同）。
 */
export function needsExtractFromRows(
  rows: readonly { extractor: string; src_hash: string }[],
  srcHash: string,
  extractorIds: readonly string[],
): boolean {
  if (extractorIds.length === 0) return false;
  const ok = new Set(rows.filter((r) => r.src_hash === srcHash).map((r) => r.extractor));
  if (rows.some((r) => r.src_hash !== srcHash)) return true;
  return extractorIds.some((id) => !ok.has(id));
}

/** 桌面侧的两个 store（见文件头注释）。`invoker` 一般是 `platform.executor`。 */
export function desktopDerivedStores(invoker: DerivedInvoker): {
  text: AttachmentTextStore;
  chunks: ChunkStore;
} {
  const text: AttachmentTextStore = {
    // 桌面库的三张表由 Rust `db::migrate` 建 ⇒ 这里什么都不做（见文件头第 1 条）。
    ensureSchema() {
      /* no-op：schema 归 Rust 的 migrate */
    },

    async needsExtract(attId, srcHash, extractorIds) {
      if (extractorIds.length === 0) return false;
      const rows = await queryRows<SegmentRowJson[]>(invoker, { op: "attachmentTextSegments", attId });
      return needsExtractFromRows(rows, srcHash, extractorIds);
    },

    async replace(
      attId,
      extractorId,
      srcHash,
      segments: readonly ExtractedSegment[],
      now,
      coverage?: ExtractCoverage,
    ) {
      await applyOps(invoker, [
        {
          op: "replaceAttachmentText",
          attId,
          extractor: extractorId,
          srcHash,
          now,
          // 覆盖度随段一起落库（与同步实现同口径）；没有 ⇒ `''` ＝ **未知**（不是"完整"）
          coverage: coverage === undefined ? "" : JSON.stringify(coverage),
          segments: segments.map((s) => ({ kind: s.kind, text: s.text, loc: s.loc })),
        },
      ]);
    },

    async removeAttachment(attId) {
      await applyOps(invoker, [{ op: "removeAttachmentText", attId }]);
    },

    async segmentsOf(attId) {
      return queryRows<SegmentRowJson[]>(invoker, { op: "attachmentTextSegments", attId });
    },

    async coverageOf(attId) {
      // Rust 只给原始行（`coverage` 是 JSON 字符串），**解析与"未知 ≠ 完整"的口径收在共用纯函数里**
      const rows = await queryRows<{ extractor: string; coverage: string }[]>(invoker, {
        op: "attachmentTextCoverage",
        attId,
      });
      return storedCoverageFrom(rows);
    },

    async stats() {
      return queryRows<StatRowJson[]>(invoker, { op: "attachmentTextStats" });
    },
  };

  const chunks: ChunkStore = {
    ensureSchema() {
      /* no-op：schema 归 Rust 的 migrate */
    },

    async replace(owner, list: readonly Chunk[]) {
      await applyOps(invoker, [{ op: "replaceChunks", owner: toOwner(owner), chunks: list.map(toChunk) }]);
    },

    async chunksOf(owner) {
      return queryRows<ChunkRowJson[]>(invoker, { op: "chunkRows", owner: toOwner(owner) });
    },

    async remove(owner) {
      await applyOps(invoker, [{ op: "removeChunks", owner: toOwner(owner) }]);
    },

    async stats() {
      return queryRows<{ chunks: number }>(invoker, { op: "chunkStats" });
    },
  };

  return { text, chunks };
}
