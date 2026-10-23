// 租约定时续（2026-10-23）：中继面板不常开，靠面板挂载触发不够 —— 这里 6 小时兜一次。
//
// 为什么放在 `AppShell`：那是解锁后常驻的根；放面板里只在该面板打开时活着，等于没有。
// ⚠️ 只在**本机有卡**时才发请求；没卡直接跳过（⛔ 不拿空卡去撞发卡站）。
import { useEffect } from "react";

import { currentCardText, refreshLease } from "./lease";

/** 6 小时（与中继租约 29 天相比足够密；一次请求很轻）。 */
export const LEASE_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** 启动后延迟 30 秒再做第一次，避开启动高峰。 */
export const LEASE_REFRESH_FIRST_DELAY_MS = 30_000;

export function useLeaseAutoRefresh(intervalMs: number = LEASE_REFRESH_INTERVAL_MS): void {
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (!alive) return;
      if (!currentCardText()) return; // 没卡 ⇒ 没得续（换租约必须有一张有效卡）
      // `refreshLease` 内部已兜住所有异常，失败只返回原因，不会炸界面。
      await refreshLease();
    };
    const first = window.setTimeout(() => void tick(), LEASE_REFRESH_FIRST_DELAY_MS);
    const timer = window.setInterval(() => void tick(), intervalMs);
    return () => {
      alive = false;
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [intervalMs]);
}
