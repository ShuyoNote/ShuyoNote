// ⭐ 2026-10-24（owner 报「同步了没有自动刷新页面」）：「远端同步回来 ⇒ 当前打开的页也要重新读」这条
// 刷新动作的**唯一节流判据**。
//
// 为什么需要它：远端变更把库里那一页换掉之后，编辑器读的是 store 里的 `current`，而同步路径
// 原来只 `loadPages()`（只换列表）⇒ 正开着的页**永远不刷新**，要切页/重启才看得到。
// 修法是在同步收口处补一次 `refreshCurrent()`（重新 `getPage` + 重挂编辑器）。
//
// 但"重挂编辑器"会把**用户正在敲、还没落库的那几百毫秒**换掉（编辑器去抖 600ms）——
// 所以只在"最近没有本地编辑"时才自动刷；正在打字 ⇒ 这一拍跳过，下一拍（默认 2~5 秒）再来。
// 判据抽成这个纯模块（只存一个时间戳），App 与同步流两条路共用**同一份**口径。
let lastLocalEditAt = 0;

/** 距上次本地编辑多少毫秒之内**不自动刷新**（编辑器保存去抖 600ms ⇒ 留足余量）。 */
export const REFRESH_IDLE_MS = 1_500;

/** 记一次"本地真的编辑了"（`onAnyLocalEdit` 那一处调用）。 */
export function markLocalEdit(atMs: number = Date.now()): void {
  lastLocalEditAt = atMs;
}

/** 距上次本地编辑经过了多少毫秒（没编辑过 ⇒ `Infinity`）。 */
export function msSinceLocalEdit(nowMs: number = Date.now()): number {
  return lastLocalEditAt === 0 ? Number.POSITIVE_INFINITY : nowMs - lastLocalEditAt;
}

/** 现在"适合让远端版本重挂编辑器"吗（判据只有这一处）。 */
export function isLocalEditRecent(nowMs: number = Date.now()): boolean {
  return msSinceLocalEdit(nowMs) < REFRESH_IDLE_MS;
}

/** 测试用：把时钟归零（生产路径没有调用点）。 */
export function resetLocalEditClockForTests(): void {
  lastLocalEditAt = 0;
}
