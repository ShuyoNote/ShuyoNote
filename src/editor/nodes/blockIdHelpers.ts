// 「自有节点」块身份／块版本的小助手（第 4 步铺开 18 个自有节点时用）。
//
// 自有节点的类**就是类型** ⇒ 不需要新 type/映射，只要类里有声明字段，再把 JSON 读写对齐。
// 这几个助手只为少写重复代码，**不隐藏任何语义**：
//   · `withBlockId`：**空 ID 不写字段** —— 嵌套实例不给身份，落盘形态与今天一致（这条是硬承诺）；
//   · `blockIdOf`：从任意序列化 JSON 里安全读 `blockId`（非字符串/缺失 ⇒ 空串）；
//   · `withBlockRev`：**只在有值时**写 `blockRev`（缺字段 = **老客户端产物**，判定层据此走"冲突提示"）；
//   · `blockRevOf`：安全读（复用 `lib/blockRev` 那一份口径，**不在这里再写一份**）。

/** 只带走身份：非空才把 `blockId` 写进 JSON。 */
export function withBlockId<T extends object>(json: T, blockId: string): T & { blockId?: string } {
  return blockId ? { ...json, blockId } : json;
}

/** 从序列化 JSON 里读 `blockId`（不是字符串就当作没有）。 */
export function blockIdOf(serialized: { blockId?: unknown }): string {
  return typeof serialized.blockId === "string" ? serialized.blockId : "";
}

/**
 * 只带走版本：**有值才**把 `blockRev` 写进 JSON。
 *
 * 为什么空值不写：`blockRev` **缺失**与 `blockRev: 0` 在判定层不是一回事 ——
 * 缺失 = "这是老客户端产物，判不了 ⇒ 提示"，`0` = "有身份但从来没被改过"（见
 * `docs/plans/2026-09-22-block-rev-write-layer.md` §3）。
 */
export function withBlockRev<T extends object>(json: T, rev: number | null): T & { blockRev?: number } {
  return typeof rev === "number" && Number.isInteger(rev) && rev >= 0 ? { ...json, blockRev: rev } : json;
}

/** 从序列化 JSON 里读 `blockRev` —— 直接复用 `lib/blockRev` 那一份实现（口径只有一处）。 */
export { blockRevOf } from "../../lib/blockRev";

/** 带块版本的节点（与 `BlockIdCarrier` 同一套写法；块级节点都实现这四个）。 */
export interface BlockRevCarrier {
  getBlockRev(): number | null;
  setBlockRev(rev: number | null): void;
}
