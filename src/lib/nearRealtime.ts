// 「近实时推送」的**开关**（桌面流通道用）。
//
// ## 为什么要单独一个文件
// 两处要用同一个键与同一条读写口径：`hooks/useSyncStream.ts`（挂载时决定起不起流）与
// `components/SyncPanel.tsx`（用户手动开关，**立刻生效**）。写两遍迟早会漂（键名写错一次就是
// "关了还在跑"或"开了没反应"）。
//
// ## 为什么存 localStorage（而不是 `meta.sync_state`）
// 这个开关只决定**界面要不要起那条流**（`sync_stream_start`）；Rust 侧不需要知道设置本身，
// 也就没有"两侧各存一份"的问题 —— 与既有的 `shuyonote:autoSync`（自动同步间隔）同一手法。
//
// ## 默认值
// **默认开**，与 Web 侧对齐（Web 那条 SSE 一直是默认开的）。要关只有一种写法：显式存 `"0"`。
// 关掉的企业理由写在设计稿 §4.4：有些代理/网关会掐长连接 —— 关掉后与今天**逐字相同**（纯轮询）。
import { api } from "./api";
import { isDesktopPlatform } from "./platform";

/** localStorage 键（只在这里写一次字面量）。 */
export const NEAR_REALTIME_KEY = "shuyonote:nearRealtime";

/** 读不到 / 没设过 ⇒ **默认开**。 */
export function isNearRealtimeEnabled(): boolean {
  try {
    return localStorage.getItem(NEAR_REALTIME_KEY) !== "0";
  } catch {
    // localStorage 不可用（Node 侧脚本 / 隐私模式）⇒ 按默认开（与本函数语义一致，不抛）
    return true;
  }
}

/** 写开关。**只管持久化**；"立刻生效"走 `applyNearRealtime`。 */
export function setNearRealtimeEnabled(on: boolean): void {
  try {
    localStorage.setItem(NEAR_REALTIME_KEY, on ? "1" : "0");
  } catch {
    /* 存不下不影响本次会话的行为（调用方已经按 `on` 去起停了） */
  }
}

/**
 * 用户**手动拨开关**时的唯一入口：持久化 ＋ **立刻生效**（不等重开页面）。
 *
 * ⚠️ 为什么不能只写 localStorage：`useSyncStream` 的 effect 依赖只有 `loadPages`，拨开关不会让它
 * 重跑 ⇒ 不在这里显式起停，"关了还在跑 / 开了没反应"。两条路（挂载、手动）因此共用同一对命令。
 *
 * ⚠️ **本片只给桌面加开关**：Web 那条流由 `useSyncStream` 自己管、且一直是默认开的；给它加开关是
 * 另一件事（要能中途 abort 那条 fetch），**不假装已经做了**。
 */
export async function applyNearRealtime(on: boolean): Promise<void> {
  setNearRealtimeEnabled(on);
  if (!isDesktopPlatform()) return;
  try {
    if (!on) {
      await api.syncStreamStop();
      return;
    }
    const wsId = await api.getActiveWorkspaceId();
    if (wsId) await api.syncStreamStart(wsId);
  } catch (e) {
    // 失败**不静默**：这是用户显式操作，界面要能看见（面板的开关状态由调用方回滚/提示）。
    console.warn("[sync] 近实时开关切换失败", e);
    throw e;
  }
}
