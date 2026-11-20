// ⭐ 2026-11-20（owner 拍「让报警出现在界面上」）：把「永久缺失」翻成**一句人话**。
//
// 为什么单独成文件：这句话是**用户可见**的，而它同时要满足三条口径 ——
// ① 不许说"会自动补"（F2-0 只报不修）；② 不许把"不知道"说成"没缺"（空数组＝没有已知缺口）；
// ③ 段数多的时候要能扫一眼，不能糊成一大段。⇒ 用纯函数钉住，界面只管摆。
//
// ⚠️ 口径说明（与后端 `mesh::missing_range` 同一件事）：`from..to` 是**闭区间**的 `device_seq`，
//    这些序号在**对端已经不存在**了（离线超过保留期 / 被清理），所以**补不回来**。

export type SyncGap = { from: number; to: number };

/** 一段缺口的条数（闭区间 ⇒ +1；坏数据 ⇒ 0，⛔ 不返回负数）。 */
export function gapCount(g: SyncGap): number {
  if (!Number.isFinite(g.from) || !Number.isFinite(g.to)) return 0;
  if (g.to < g.from) return 0;
  return Math.floor(g.to) - Math.floor(g.from) + 1;
}

/** `238..240` / `238` 这种显示形态（单条时只写一个数）。 */
export function gapRangeText(g: SyncGap): string {
  if (!Number.isFinite(g.from) || !Number.isFinite(g.to) || g.to < g.from) return "—";
  return g.from === g.to ? `${g.from}` : `${g.from}..${g.to}`;
}

/**
 * 界面那一行。**没有缺口 ⇒ `null`**（调用方据此**不渲染**，⛔ 不显示"0 条缺口"这种噪音）。
 *
 * 形状（逐字）：
 * · 1 段：`⚠️ 有 3 条永久缺失（238..240）—— 已经补不回来了：对端那条记录不在了，只能全量重同步或从备份恢复`
 * · 多段：`⚠️ 有 2 段永久缺失，共 5 条（238..240、300）—— …`（最多列 3 段，其余写「等 N 段」）
 */
export function gapNoticeText(gaps: SyncGap[] | null | undefined): string | null {
  if (!Array.isArray(gaps) || gaps.length === 0) return null;
  const valid = gaps.filter((g) => gapCount(g) > 0);
  if (valid.length === 0) return null;
  const total = valid.reduce((n, g) => n + gapCount(g), 0);
  const shown = valid.slice(0, 3).map(gapRangeText).join("、");
  const more = valid.length > 3 ? ` 等 ${valid.length} 段` : "";
  if (valid.length === 1) {
    return `⚠️ 有 ${total} 条永久缺失（${shown}）—— 已经补不回来了：对端那条记录不在了，只能全量重同步或从备份恢复`;
  }
  return `⚠️ 有 ${valid.length} 段永久缺失，共 ${total} 条（${shown}${more}）—— 已经补不回来了：对端那条记录不在了，只能全量重同步或从备份恢复`;
}
