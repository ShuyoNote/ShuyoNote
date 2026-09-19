// 派生文本层的**运输契约**（TS 侧）：与 Rust `src-tauri/src/derived_transport.rs` 一一对应。
//
// 为什么要有这个模块（而不是各处手拼 payload）：命令面收的是 serde 的 tag 枚举，
// **字段名靠约定对齐**（`rename_all = "camelCase"`）—— 两边各写一份就一定会漂，
// 而漂了的症状是"命令报错 missing field"或更糟（字段静默为默认值）。
// 所以：① 类型集中在这里；② 有一条**跨语言夹具**（`tests/derived-transport-ops.json`）
// 同时被 TS 测试（构造结果逐字相同）与 Rust 测试（每条都能反序列化）钉住。
//
// 纪律（与 Rust 侧同一条，写在两处是因为它就是设计）：**只搬不决定** ——
// 这里不做归一化、不算 hash、不切块；那些是 `extract/` 的活。

/** 与 Rust `DerivedOwner` 同形。 */
export type DerivedOwner =
  | { kind: "page"; pageId: string }
  | { kind: "attachment"; attId: string };

/** 与 Rust `SegmentIn` 同形（`seq` 由运输层按下标补）。 */
export interface DerivedSegment {
  kind: string;
  text: string;
  loc?: string;
}

/** 与 Rust `ChunkIn` 同形。 */
export interface DerivedChunk {
  id: string;
  pageId?: string | null;
  attId?: string | null;
  ord: number;
  loc?: string;
  lang?: string;
  text: string;
  hash: string;
}

export type DerivedOp =
  | {
      op: "replaceAttachmentText";
      attId: string;
      extractor: string;
      srcHash: string;
      now: number;
      segments: DerivedSegment[];
    }
  | { op: "removeAttachmentText"; attId: string }
  | { op: "replaceChunks"; owner: DerivedOwner; chunks: DerivedChunk[] }
  | { op: "removeChunks"; owner: DerivedOwner };

export type DerivedQuery =
  | { op: "attachmentTextSegments"; attId: string }
  | { op: "chunkRows"; owner: DerivedOwner }
  | { op: "chunkStats" }
  | { op: "attachmentTextStats" };

export interface DerivedApplyReport {
  ops: number;
  rows: number;
}

/** 命令面的调用体（与 `platform/executor.invoke` 同形，便于单测注入假实现）。 */
export interface DerivedInvoker {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
}

/**
 * 一批写操作（**一个事务**：要么全落、要么一行不留）。
 *
 * ⚠️ 收一批而不是一次一条：TS 的 `replace` 是"先删后插 N 条"，逐条往返在桌面（SQLCipher）上慢，
 * 更要紧的是**中途失败会留下半批**（而 `src_hash` 已更新 ⇒ `needsExtract` 误判为"已抽好"）。
 */
export function applyOps(invoker: DerivedInvoker, ops: readonly DerivedOp[]): Promise<DerivedApplyReport> {
  return invoker.invoke<DerivedApplyReport>("derived_apply", { ops });
}

/** 读一行/一批（只读）。返回的形状由各查询决定，调用方收窄。 */
export function queryRows<T>(invoker: DerivedInvoker, query: DerivedQuery): Promise<T> {
  return invoker.invoke<T>("derived_query", { query });
}
