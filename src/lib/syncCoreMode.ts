// ⭐ P3-1a 第五刀（task-58）：**自动同步走 Core 还是走前端定时器**的纯函数决策。
//
// 口径（唯一实现 ⇒ App 与判据共用）：
// · `autoSyncMs <= 0`（同步方式「关闭」且没开近实时）⇒ **off**（Core/定时器都不跑）；
// · **移动端** ⇒ **timer**（Rust Core 是可选的，移动端保持今天的前端节拍）；
// · **桌面 ＋ 网络闸门拒绝**（蜂窝且开了仅 Wi-Fi 等）⇒ **timer**（回退旧路：它自己每轮还会
//   再过一次闸门并写日志 ⇒ 行为与今天一致）；
// · **桌面 ＋ 闸门放行** ⇒ **core**（App 用 `sync_core_set_enabled(true)` 打开 Rust 调度器，
//   并且**不排**前端 setTimeout 循环）。
//
// ⚠️ 编辑触发（`requestAutoSyncRound`）**不受这个决策影响**：它仍然走命令路径（用户刚敲完，
//   要求立刻传，与"定时节拍由谁跑"是两件事）。

export type SyncAutoMode = "core" | "timer" | "off";

export interface SyncAutoModeInput {
  isDesktop: boolean;
  /** `effectiveAutoSyncMs()`（0 ＝ 总闸关闭）。 */
  autoSyncMs: number;
  /** `shouldAutoSyncNow()` 的结果（网络闸门）。 */
  gateAllowed: boolean;
}

/** 决策表（纯函数）。 */
export function decideSyncAutoMode(input: SyncAutoModeInput): SyncAutoMode {
  if (!(input.autoSyncMs > 0)) return "off";
  if (!input.isDesktop) return "timer";
  if (!input.gateAllowed) return "timer";
  return "core";
}

/** 是否还要排**前端**自动同步定时器（Core 跑时不排；off 时也不排）。 */
export function shouldScheduleFrontendTimer(input: SyncAutoModeInput): boolean {
  return decideSyncAutoMode(input) === "timer";
}

/** 是否要打开 Rust Core（只有 core 档）。 */
export function shouldEnableRustCore(input: SyncAutoModeInput): boolean {
  return decideSyncAutoMode(input) === "core";
}
