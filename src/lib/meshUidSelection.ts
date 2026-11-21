// ⭐ A3（2026-11-21）：同名空间「确认是同一个」的**批量选择 → 要送的键**（纯函数）。
//
// 为什么单独一个模块：`MeshUidConflicts.tsx` 只该管渲染与点击；"勾了哪些行 ⇒ 送哪些键"
// 是可以逐条判的东西，放这里就能在 vitest 里钉住（⛔ 不靠读 JSX 猜）。
//
// 三条判据（与 Rust `mesh_uid_confirm::plan_batch_confirm` 同名、分工不同）：
// ① `batch-selected-only` —— 批量阶段**只从勾选里出发**：返回的每个键都来自 `checked`，
//    未勾选的一行都不给（调用方拿它当请求体，⛔ 不自己扩写）；
// ② `propagate-same-uid-only` —— `sameUidExtra` 只数 **uid 与本批勾选相同**、自己没被勾的候选；
//    uid 不同 ⇒ **永不计数**（传播由后端在同一事务里做，前端只预览条数）；
// ③ `empty-selection-writes-nothing` —— 空选／没有候选 ⇒ 空数组（调用方据此**不发请求**）。
//
// ⚠️ 界面文案里**不显示** `peerDevice` / `peerUid`（内部标识，`INV-UI-copy-no-internal-ids`）；
//    本模块只把它们当键用，⛔ 不往 DOM 里写。

/** 一对「对端设备 ＋ 对端报的空间 uid」—— 确认表的键（⛔ 不是给人看的）。 */
export type UidPair = { peerDevice: string; peerUid: string };

/** 行键：同一台设备的同一个 uid 只可能有一行（与后端候选表主键同形）。 */
export function uidPairKey(p: UidPair): string {
  return `${p.peerDevice}|${p.peerUid}`;
}

/**
 * 判据 ①：**勾了哪些行 ⇒ 送哪些键**（顺序跟 `rows`，去重由行键天然保证）。
 *
 * ⚠️ 只认 `rows` 里真有的行：勾选状态里残留的旧键（列表刷新后已消失的候选）不会出现在结果里。
 */
export function selectedPairs<T extends UidPair>(rows: readonly T[], checked: ReadonlySet<string>): UidPair[] {
  return rows
    .filter((r) => checked.has(uidPairKey(r)))
    .map((r) => ({ peerDevice: r.peerDevice, peerUid: r.peerUid }));
}

/**
 * 判据 ②：这一批勾选**会额外带上**几条（＝ 同 uid、自己没被勾的其它候选）。
 *
 * ⛔ uid 不同的一律不数 —— 界面上那句"另外 N 对也会一并确认"就必须与后端计划一致，
 * 否则用户会以为自己确认了根本没确认的东西。
 */
export function sameUidExtra<T extends UidPair>(rows: readonly T[], selected: readonly UidPair[]): number {
  if (selected.length === 0) return 0;
  const uids = new Set(selected.map((s) => s.peerUid));
  const picked = new Set(selected.map(uidPairKey));
  return rows.filter((r) => uids.has(r.peerUid) && !picked.has(uidPairKey(r))).length;
}
