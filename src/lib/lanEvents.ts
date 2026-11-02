// ⭐ **2026-10-27（owner「go」：同步面板状态自动刷新）**：订阅后端那条"局域网读数变了"的事件。
//
// ## 它解决什么
// 面板原来只靠**轮询**（5 秒读一次 `lan_status`、15 秒读一次历史）⇒ 对端一露面、窗口一开/关，
// 用户最多要等 5 秒才看见。现在后端在**真变了**的时候推一次 `lan:changed`
// （`lan_state::start` 的发现循环里，指纹见 `lan_change_fingerprint`）⇒ 面板立刻重读。
//
// ## 三条口径
// 1. ⭐ **轮询保留** ✗ —— 这个订阅只是"更快"，⛔ 不是替代：老构建没有这条事件、Web 也没有
//    ⇒ 取不到就返回 no-op，5 秒轮询照旧兜底 ✓（与"读不到就说读不到"同一把尺 ✓）。
// 2. ⛔ **不在 Web/无 Tauri 内核上抛错** ✗：动态 import + try/catch ⇒ 失败只是"没有这条通道"。
// 3. ⛔ **不在这里改任何读数** ✗：回调只通知"去重读一次"，读数仍由 `lan_status` 一处产出。
const EVENT = "lan:changed";

/**
 * 订阅「局域网读数变了」。返回**退订函数**（取不到通道时返回 no-op）。
 * ⚠️ 调用方必须在卸载时退订（否则面板关掉后回调还会跑）。
 */
export async function subscribeLanChanged(cb: () => void): Promise<() => void> {
  try {
    const { listen } = await import("@tauri-apps/api/event");
    return await listen(EVENT, () => cb());
  } catch {
    return () => {};
  }
}

/** 事件名（判据用；⛔ 别在别处再写一遍字面量 ✗）。 */
export const LAN_CHANGED_EVENT = EVENT;
