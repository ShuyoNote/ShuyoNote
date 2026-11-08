// ⭐ P3-1a 第五刀（task-58）：**自动同步走 Core 还是走前端定时器**的纯函数决策。
//
// 口径（唯一实现 ⇒ App 与判据共用）：
// · `autoSyncMs <= 0`（同步方式「关闭」且没开近实时）⇒ **off**（Core/定时器都不跑）；
// · **移动端** ⇒ **timer**（Rust Core 是可选的，移动端保持今天的前端节拍）；
// · **桌面 ＋ autoSyncMs>0** ⇒ **core**（App 用 `sync_core_set_enabled(true)` 打开 Rust 调度器，
//   并且**不排**前端 setTimeout 循环）。
//
// ⭐ **P3-1a 收尾（task-69）**：桌面分支**不再看前端网络闸门** —— Core 已内置同一把闸门
//   （`sync_core::auto_sync_gate`，task-68）⇒ 由它每轮决定拒/放；前端闸门只保留在
//   **移动端/回退定时器**与**编辑触发**路径上（它们仍走 `runAutoSyncRound` 里的
//   `shouldAutoSyncNow()`）。
//
// ⚠️ 编辑触发（`requestAutoSyncRound`）**不受这个决策影响**：它仍然走命令路径（用户刚敲完，
//   要求立刻传，与"定时节拍由谁跑"是两件事）。

export type SyncAutoMode = "core" | "timer" | "off";

export interface SyncAutoModeInput {
  isDesktop: boolean;
  /** `effectiveAutoSyncMs()`（0 ＝ 总闸关闭）。 */
  autoSyncMs: number;
  // ⭐ task-69：**没有** `gateAllowed` —— 桌面 Core 的网络闸门在 Rust 内部（每轮判）；
  //   前端闸门只用于 timer 回退/编辑触发，不参与 core/timer 决策。
}

/** 决策表（纯函数）。 */
export function decideSyncAutoMode(input: SyncAutoModeInput): SyncAutoMode {
  if (!(input.autoSyncMs > 0)) return "off";
  if (!input.isDesktop) return "timer";
  // ⭐ task-69：桌面（间隔>0）一律 Core；网络闸门由 Core 每轮自行判（⛔ 不再看前端 gate）。
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
