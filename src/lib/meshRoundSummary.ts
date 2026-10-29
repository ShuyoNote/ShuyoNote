// 同步面板的「本轮进度 / 本轮摘要」——**纯函数**（判据不打桩、不看网络）。
//
// 背景（owner 2026-10-29「在同步面板显示实时同步日志是否合适」）：
// 结论是不做常驻日志；改为把**这一轮**的进度与结果说清：
//   · 同步中：`正在同步「工作」… 附近 2 台 · 已 3s`（不编造"第 2/5 个空间"——手动同步是按空间的）；
//   · 同步完：Rust 的 `rep.note` 原样用，**只补一个它没说、用户关心的数**：本轮收下几页。
// ⚠️ 「收下几页」也必须用 **Rust 算好的** `rep.applied`（`MeshRoundReport.applied`），
//    ⛔ 界面不许自己遍历 `peers` 去数（`syncPanelMesh.wiring` ⑦ 钉着这条）。
export function meshProgressText(spaceName: string, nearbyCount: number, elapsedMs: number): string {
  const name = spaceName.trim() || "这个空间";
  const secs = Math.max(0, Math.floor(elapsedMs / 1000));
  const nearby = nearbyCount > 0 ? `附近 ${nearbyCount} 台 · ` : "";
  return `正在同步「${name}」… ${nearby}已 ${secs}s`;
}

/**
 * 接在 Rust `rep.note` 后面的**一句补充**。
 *
 * ⚠️ 只补「本轮收下几页」：`rep.note` 已经说了"拉了几台 / 几台没拉动 / 几页待裁决 / 几页让出版本"，
 * 再说一遍就是两处同义（本仓的老教训）。没有收下任何页 ⇒ 返回空串（别补一句"收下 0 页"的废话）。
 */
export function meshRoundSummaryText(applied: number): string {
  return applied > 0 ? `（本轮收下 ${applied} 页）` : "";
}
