// C2 网络闸门（2026-09-15）：**自动同步**该不该在这一刻跑。
//
// ## 为什么必须抽成一处（真机验收发现的坑）
//
// 仓里当时有**两条**"自动同步"的路径：
//   ① `hooks/useAutoSync.ts`（启动后 3 秒一次 + 固定 5 分钟一次）；
//   ② `App.tsx` 里那个按**面板设置**间隔（localStorage `shuyonote:autoSync`）跑的定时器。
// 我最初只给 ① 加了闸门 —— 于是把面板里的自动同步设成"每 10 秒"就会**绕过闸门**、
// 在蜂窝上照拉。两条路各写一份判断也迟早会漂，所以规则只留在这里。
//
// ★ **2026-09-26 口径收敛**：两条路合成**一条** —— ① 那条（固定 5 分钟、走老的全局配置
// `api.syncNow()`）删掉了，"启动后 3 秒先跑一次"并进 ②；现在自动同步只有 `App.tsx` 那一段，
// 按**面板间隔**、按**每空间档案**跑，并且**顺手也跑网格**（丙）。闸门仍然是这一处实现。
//
// ## 判据
//
// · `wifi_only` 关 ⇒ 放行（用户明确允许非 Wi-Fi）。
// · `network_type` 回 `"n/a"`（非 Android，闸门**不适用**）⇒ 放行（**不能**当"未知"拦掉，
//   否则桌面端的自动同步会被一起关掉）。
// · 其余非 `wifi`/`ethernet`（含 `"unknown"`：Android 上真查不到）⇒ **拦截**。
//   这个方向是刻意选的 fail-safe：猜错成"有 Wi-Fi"而其实是蜂窝，代价是**偷偷跑用户流量**。
//
// ⚠️ **只管自动**：手动点「同步」不经过这里（用户明确要求就该照做）。
import { api } from "./api";

/**
 * ⭐ **task-12（owner 拍 C）**：闸门那一轮的**人话** —— 纯函数（判据够得着 ✓）。
 *
 * ⚠️ 为什么必须有它：`shouldAutoSyncNow()` 以前**被挡时一句日志都不打** ✗ ⇒
 * 「**没触发** ／ ⭐ **触发了但被闸门挡下** ／ ⭐ **触发了但同步失败**」这三件**在日志里同形** ✓ ——
 * 而它们**处置完全不同** ✓（前者去看谁该触发 ✓、中间去看闸门口径 ✓、后者去看错误 ✓）。
 * 与本轮发现层那三行**同一形状** ✓（Lead 原话 ✓）。
 */
export function autoSyncGateLine(kind: string, wifiOnly: boolean, allow: boolean): string {
  const why = !wifiOnly
    ? "用户允许非 Wi-Fi（wifi_only 关 ✓）"
    : kind === "n/a"
      ? "桌面端：闸门不适用（network_type = n/a ✓）"
      : kind === "wifi" || kind === "ethernet"
        ? `在有线/无线网络上（${kind} ✓）`
        : `**网络类型不合适**（${kind}）⇒ 按 fail-safe 拦下：宁可少跑一次，也不偷偷跑用户流量`;
  return `[sync] 自动同步这一轮${allow ? "**放行**" : "**被闸门挡下**"}：原因＝${why}`;
}

export async function shouldAutoSyncNow(): Promise<boolean> {
  // 读不到预算（老库 / 命令失败）时**按默认放行**：不能因为读不到设置就把自动同步整个停掉。
  const budget = await api.getSyncBudget().catch(() => null);
  if (!budget?.wifi_only) {
    // ⭐ task-12：放行也要留一行 ✓（否则"没触发"与"放行了但没跑"分不开 ✗）
    console.info(autoSyncGateLine("n/a", false, true));
    return true;
  }
  const kind = await api.networkType().catch(() => "unknown");
  const allow = kind === "n/a" || kind === "wifi" || kind === "ethernet";
  // ⭐ task-12：**挡下时逐字写出原因** ✓ —— 这一格以前是完全静默的 ✗。
  console.info(autoSyncGateLine(kind, true, allow));
  return allow;
}
