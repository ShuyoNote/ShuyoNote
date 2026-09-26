// 「同步方式」：把原来**两个**控件（自动同步间隔四档 ＋ 近实时开关）收成**一个**三选一。
//
// 为什么可以合：它们本来管的是同一件事的两个旋钮 —— "这台设备多久跟外面同步一次"。
// 分开摆的代价是用户得在脑子里把两件事叠起来算（"间隔 30 秒" ＋ "近实时也开着" 到底是什么行为），
// 而面板上还有第三个"只在 Wi-Fi 下"。2026-09-26 口径收敛：**一个下拉 ＋ 一个 Wi-Fi 开关**。
//
// ⚠️ **「近实时」那一档仍然保留轮询**（`SYNC_REALTIME_FALLBACK_MS`）：流通道"能连上才有"，
//    断了就该退回轮询 —— 本仓有一条判据专门钉"轮询必须**无条件**挂着，不是「开近实时就不轮询」"
//    （`useSyncStream.wiring.test.ts` ⑧）。所以这一档不是"关掉轮询"，是**把间隔拉长当兜底**。
//
// ⚠️ 这里是读写的**唯一一处**：面板只调 `settingsForMode`，不再"左边改一个、右边改一个"
//    （那种写法的下场是两处口径漂开，而漂开时没有任何东西会红）。
export type SyncMode = "off" | "interval" | "realtime";

/**
 * 「按间隔」那一档的间隔。收窄成**一档**：原来四档（10 秒 / 30 秒 / 1 分钟 / 5 分钟）里，
 * 用户没法预期哪一档合适，而"自动同步多久一次"这件事本来就是**一个档位**的事。
 */
export const SYNC_INTERVAL_MS = 30_000;

/** 「近实时」那一档的**兜底**轮询间隔：流断了也还能自己找回来（5 分钟）。 */
export const SYNC_REALTIME_FALLBACK_MS = 5 * 60_000;

/** 当前设置落在哪一档（**读**：老值也能映射回来，不会把用户原来的设置"读没了"）。 */
export function syncModeOf(autoMs: number, nearRealtime: boolean): SyncMode {
  if (nearRealtime) return "realtime";
  return autoMs > 0 ? "interval" : "off";
}

/** 选了某一档之后，那两个底层设置该是什么（**写**：一处实现）。 */
export function settingsForMode(mode: SyncMode): { autoMs: number; nearRealtime: boolean } {
  switch (mode) {
    case "off":
      return { autoMs: 0, nearRealtime: false };
    case "interval":
      return { autoMs: SYNC_INTERVAL_MS, nearRealtime: false };
    case "realtime":
      // ★ 兜底轮询**必须 > 0**：它保证"轮询无条件挂着"那条不变式在这一档下也成立。
      return { autoMs: SYNC_REALTIME_FALLBACK_MS, nearRealtime: true };
  }
}

/** 面板里那一句人话（说明这一档到底会发生什么）。**只在这里写一次**。 */
export function syncModeHint(mode: SyncMode): string {
  switch (mode) {
    case "off":
      return "不自动同步：只有点「同步」时才同步（网格也跟着那一次走）。";
    case "interval":
      return "每 30 秒自动跑一次（服务端那条 ＋ 网格那条）。";
    case "realtime":
      return (
        "连着同步服务时，对端一改就立刻拉一次；连不上时退回每 5 分钟兜底一次。" +
        "（有些代理会掐长连接 —— 那时换成「按间隔」更省心。）"
      );
  }
}

/** 存这个档位的 localStorage 键（`App.tsx` 里那条定时器就认它）。 */
export const AUTO_SYNC_KEY = "shuyonote:autoSync";

/**
 * 改了档位之后广播的事件名。
 *
 * ⚠️ **为什么需要它**：`App.tsx` 那条定时器是在**自己的渲染**里读 localStorage 的 ——
 * 面板改了档，App 不会因此重渲染 ⇒ 定时器**不会重挂**（"选了按间隔，可它没开始跑"，
 * 得等 App 因为别的原因再渲染一次）。所以写档位时**广播一下**，App 订阅它并把值放进 state。
 */
export const AUTO_SYNC_CHANGED_EVENT = "shuyonote:autoSyncChanged";

/** 读当前档位的毫秒数（读不出来 ⇒ 0 ＝ 关闭，与面板"读不到就是关"一致）。 */
export function readAutoSyncMs(): number {
  try {
    return Number(localStorage.getItem(AUTO_SYNC_KEY)) || 0;
  } catch {
    return 0;
  }
}

/** 写档位并**广播**（面板改档的唯一入口）。 */
export function writeAutoSyncMs(ms: number): void {
  try {
    localStorage.setItem(AUTO_SYNC_KEY, String(ms));
    window.dispatchEvent(new Event(AUTO_SYNC_CHANGED_EVENT));
  } catch {
    /* localStorage 不可用（隐私模式等）⇒ 只影响"记住档位"，不影响本次行为 */
  }
}
