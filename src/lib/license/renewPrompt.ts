// 「该不该提示续期」的唯一判断处（owner 口径，2026-10-18）。
//
// ⚠️ 为什么要单独一个文件：这个判断会出现在**三个**地方（设置面、状态条、启动时的轻提示），
//   三处各写一个 `if` 必然漂 —— 而漂的方向是**在停卡的卡上提示续期**（用户点了续期，发卡站
//   签出来的还是停卡，用户会以为"付了钱没用"）✗。
//
// 四条口径（逐字来自任务书 §2）：
//   · active 且 剩余 ≤ 7 天 ⇒ 提示续期
//   · grace / expired     ⇒ **必须**提示（宽限一过就静默断网）
//   · stopped             ⇒ ⛔ **不提示续期**（要走"重新开通"）
//   · not-yet             ⇒ 不提示
import type { CardState } from "./card";

/** 提前多少天开始提示续期。 */
export const RENEW_WARN_DAYS = 7;

export type RenewAction = "none" | "renew" | "reopen";

export interface RenewDecision {
  /** 要做什么：什么都不做 / 提示续期 / 提示"重新开通" */
  action: RenewAction;
  /** 给界面的一句话；`none` 时为空串（⛔ 别留一个空壳元素） */
  text: string;
}

/**
 * 判断现在该提示什么。
 *
 * @param state 当前那张卡的五态（`cardState`）
 * @param days  剩余天数（`daysLeft`；仅 active/grace 有意义）
 */
export function renewDecision(state: CardState, days: number): RenewDecision {
  switch (state) {
    case "active":
      return days <= RENEW_WARN_DAYS
        ? { action: "renew", text: `跨网同步还剩 ${days} 天，建议现在续期。` }
        : { action: "none", text: "" };
    case "grace":
      return {
        action: "renew",
        text: `跨网同步已进入宽限期（还剩 ${days} 天），宽限一过就会断 —— 请尽快续期。`,
      };
    case "expired":
      return { action: "renew", text: "跨网同步已过期（本机读写不受影响），续期即可恢复。" };
    case "stopped":
      // 🔴 停卡不等于过期：这张卡是被**主动停掉**的 ⇒ 续期不解决问题，要走重新开通。
      return { action: "reopen", text: "已停卡 · 只停了跨网（本机读写不受影响）。要恢复请重新开通。" };
    case "not-yet":
      return { action: "none", text: "" };
  }
}
