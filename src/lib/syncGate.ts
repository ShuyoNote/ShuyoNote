// C2 网络闸门（2026-09-15）：**自动同步**该不该在这一刻跑。
//
// ## 为什么必须抽成一处（真机验收发现的坑）
//
// 仓里有**两条**"自动同步"的路径：
//   ① `hooks/useAutoSync.ts`（启动后 3 秒一次 + 固定 5 分钟一次）；
//   ② `App.tsx` 里那个按**面板设置**间隔（localStorage `shuyonote:autoSync`）跑的定时器。
// 我最初只给 ① 加了闸门 —— 于是把面板里的自动同步设成"每 10 秒"就会**绕过闸门**、
// 在蜂窝上照拉。两条路各写一份判断也迟早会漂，所以规则只留在这里。
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

export async function shouldAutoSyncNow(): Promise<boolean> {
  // 读不到预算（老库 / 命令失败）时**按默认放行**：不能因为读不到设置就把自动同步整个停掉。
  const budget = await api.getSyncBudget().catch(() => null);
  if (!budget?.wifi_only) return true;
  const kind = await api.networkType().catch(() => "unknown");
  return kind === "n/a" || kind === "wifi" || kind === "ethernet";
}
