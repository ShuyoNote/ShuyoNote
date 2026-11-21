// ⭐ A3（2026-11-21，owner 拍「只批量、不传播」）：同名空间「确认是同一个」的**批量选择 → 要送的键**（纯函数）。
//
// 为什么单独一个模块：`MeshUidConflicts.tsx` 只该管渲染与点击；"勾了哪些行 ⇒ 送哪些键"
// 是可以逐条判的东西，放这里就能在 vitest 里钉住（⛔ 不靠读 JSX 猜）。
//
// 三条判据（与 Rust `mesh_uid_confirm::plan_batch_confirm` 同名、分工不同）：
// ① `batch-selected-only` —— 批量阶段**只从勾选里出发**：返回的每个键都来自 `checked`，
//    未勾选的一行都不给（调用方拿它当请求体，⛔ 不自己扩写）；
// ② `no-propagation-on-batch` —— **不做传播**：另一个候选哪怕 `peerUid` **完全相同**、
//    只要没被勾就**不在结果里**（"同一个 uid ⇒ 同一个空间"这个推断不替用户做）；
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
 * ⚠️ 判据 ② 也在这里成立：函数里**没有**"同 uid 就顺带带上"这一步 —— 勾一行只回一行。
 */
export function selectedPairs<T extends UidPair>(rows: readonly T[], checked: ReadonlySet<string>): UidPair[] {
  return rows
    .filter((r) => checked.has(uidPairKey(r)))
    .map((r) => ({ peerDevice: r.peerDevice, peerUid: r.peerUid }));
}
