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
//
// ⚠️ 单向依赖：本文件 import `nearRealtime`（因为**有效间隔**是两个键的函数，见
//    `effectiveAutoSyncMs`），**反向不许** —— 那边要广播就调 `broadcastAutoSyncChanged`，
//    事件名只在本文件里写一次（写成互相 import 就是一个环）。
import { isNearRealtimeEnabled } from "./nearRealtime";

export type SyncMode = "off" | "interval" | "realtime";

/**
 * 「按间隔」那一档的间隔。收窄成**一档**：原来四档（10 秒 / 30 秒 / 1 分钟 / 5 分钟）里，
 * 用户没法预期哪一档合适，而"自动同步多久一次"这件事本来就是**一个档位**的事。
 */
export const SYNC_INTERVAL_MS = 30_000;

/** 「近实时」那一档在**服务端档**的**兜底**轮询间隔：流断了也还能自己找回来（5 分钟）。 */
export const SYNC_REALTIME_FALLBACK_MS = 5 * 60_000;

/**
 * 「拉取间隔」—— **设备直连这一档的节拍**（owner 2026-09-29 拍板：默认 **5 秒**）。
 *
 * ## 为什么"局域网那条路"必须有自己的一个数
 *
 * 同一个数在两种档位下含义**完全不同** ——
 *   · **服务端档**：那条 SSE 流（`sync_stream`）正常时会把变更推过来
 *     ⇒ 这个轮询只是"**流断了**"的保险 ⇒ 拉长到 5 分钟（省请求）是对的。
 *   · **局域网档**：**没有 SSE**（`stream_url(server, space_id)` 连的是 `server_url`）
 *     ⇒ 这个轮询就是【**主发动机**】—— 用 5 分钟当主发动机 ⇒ 手感就是"5 分钟才动一次"。
 *   ⇒ 同一个数当保险丝是 5 分钟、当发动机是 5 秒。**它们不该共用一个常量**（本仓铁律：
 *     一个量只该有一个含义）。局域网内一次拉取很便宜（直连、无外网），5 秒是划得来的。
 *
 * ## 为什么它必须是一个**用户可见、可持久化**的设置（而不是代码里悄悄换）
 *
 * 在这之前是这样：`lanMeshActive`（＝ Rust 判的"网格开着吗"）一为真，
 * [`effectiveAutoSyncMs`] 就**背着用户把间隔从 5 分钟换成 5 秒**。两个问题：
 * 1. **用户看不见** —— 面板上写着「近实时（连着服务端时立刻拉）」，实际却每 5 秒跑一次；
 * 2. **换不换取决于一个他不在看的开关**（设备直连）⇒ 同一个下拉在两台机器上手感完全不同。
 * ⇒ 现在：**间隔由用户选**（5 秒 / 30 秒 / 1 分钟），面板上有一行把它显示出来，
 *    落盘在下面那个键里；而"设备直连关着 ⇒ 这一档不适用"仍然成立（见 [`effectiveAutoSyncMs`]）。
 *    （老名字 `SYNC_LAN_INTERVAL_MS` 连同"按 `mesh.enabled` 偷偷换"那条路一起撤了 ——
 *     它的理由搬到这里，一个字没丢。一个量只有一个名字。）
 *
 * ⚠️ 与 `shuyonote:autoSync`（「同步方式」那一档）**是两个键、两个含义**：
 *    那个管"要不要自动同步、走哪一档"，这个管"局域网那条路的节拍"。
 *    一个量只该有一个含义（本仓铁律）。
 */
export const PULL_INTERVAL_KEY = "shuyonote:lanPullIntervalMs";

/**
 * 三档（面板那一行就摆这三个）。**默认 5 秒**（owner 拍的，理由见上面 `SYNC_REALTIME_FALLBACK_MS`
 * 那段：局域网那条路没有流 ⇒ 这个轮询是主发动机）。
 */
export const PULL_INTERVALS: { ms: number; label: string }[] = [
  { ms: 5_000, label: "5 秒" },
  { ms: 30_000, label: "30 秒" },
  { ms: 60_000, label: "1 分钟" },
];

/** 默认那一档（**5 秒**）。它同时是"读不出来 / 没设过"时的回落值。 */
export const PULL_INTERVAL_DEFAULT_MS = 5_000;

/**
 * 读「拉取间隔」（**唯一一处读**）。
 *
 * 口径：**读不出来 / 没设过 / 存了不是三档里的值 ⇒ 回落默认 5 秒**（不是 0）。
 * ⚠️ 为什么"回落默认"而不是"回落 0"：0 的含义是"不自动跑"，而这一档**没有**"关"这个语义
 *    （"关"由父项「设备直连」表达 —— 那种时候这一行**根本不显示**，见 `SyncPanel`）。
 */
export function readPullIntervalMs(): number {
  try {
    const raw = Number(localStorage.getItem(PULL_INTERVAL_KEY));
    return PULL_INTERVALS.some((o) => o.ms === raw) ? raw : PULL_INTERVAL_DEFAULT_MS;
  } catch {
    // localStorage 不可用（隐私模式 / Node 侧脚本）⇒ 按默认走，**不抛**（与 `nearRealtime` 同款）。
    return PULL_INTERVAL_DEFAULT_MS;
  }
}

/** 写「拉取间隔」＋**广播**（App 那条定时器要按新节拍重挂）。**唯一一处写**。 */
export function writePullIntervalMs(ms: number): void {
  try {
    localStorage.setItem(PULL_INTERVAL_KEY, String(ms));
  } catch {
    /* 存不下只影响"记住这一档"，不影响本次行为 —— 但仍要广播（本次立刻生效） */
  }
  broadcastAutoSyncChanged();
}

/** 那一行右边显示的字（与 [`PULL_INTERVALS`] 的 `label` **同一处口径**，不另写一套）。 */
export function pullIntervalLabel(ms: number): string {
  return PULL_INTERVALS.find((o) => o.ms === ms)?.label ?? PULL_INTERVALS[0].label;
}

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

/**
 * ★★ **行为侧的唯一入口**：App 那条定时器该按多少毫秒跑（`App.tsx` 读它，不读 `readAutoSyncMs`）。
 *
 * 为什么不能直接用 `readAutoSyncMs()`（2026-09-26 两台真机实测的口径不一致）：
 * 「近实时」那一档的开关**默认就是开**（`lib/nearRealtime.ts`），而"间隔"那个键**只有用户动过
 * 下拉框才会被写**。于是**从没动过下拉框**的机器落在 `{间隔: 没写(=0), 近实时: 开}` 这个状态 ——
 * 面板显示「近实时」、那句人话承诺"连不上时**退回每 5 分钟兜底一次**"，而**定时器压根没挂**：
 * 一次自动同步都不会发生。方向是最坏的那种（用户以为在自动同步，其实没有）。
 * ⚠️ 这个状态**本来就是判据里的坏设置**：`syncMode.test.ts` 把不变式写成谓词
 *    `pollingStillMounted({autoMs: 0, nearRealtime: true}) === false`（"轮询必须无条件挂着"）。
 *    以前只有**写**那一侧守它（`settingsForMode("realtime")` 给 5 分钟），**读**这一侧没兑现。
 *
 * 口径（一句话）：**近实时开着 ⇒ 兜底轮询必须挂着**，值与 `settingsForMode("realtime")` 同源。
 * ⚠️ 近实时关着而档位是 0 ⇒ **真的是"关闭"**（一个字都不自动跑），这里不偷加。
 */
/**
 * 「局域网档现在开着吗」—— 由**拿到 `lan_status` 的那一处**设（今天只有同步面板），
 * 与 `nearRealtime` 同款：模块级状态 ＋ 变化时广播，让 `App` 那个定时器跟着换间隔。
 *
 * ⚠️ 为什么不能用 `lan_status.kind` 在这里现判：它是**异步命令**，而本函数是**同步纯函数**
 *    （定时器读它）。⇒ 只能由调用方**喂**进来。
 * ⚠️ 判据 ⑭ 钉的是「界面不许**按地址形状自己再判**一次档」；这里用的是 Rust 判好的
 *    `mesh.enabled`（＝ `cfg.bind.is_some()`），**不是**自己解析地址 ⇒ 合规。
 */
let lanMeshActive = false;

/** 设置「局域网档开着吗」。**值没变就什么都不做**（否则每次轮询都会广播一圈）。 */
export function setLanMeshActive(on: boolean): void {
  if (lanMeshActive === on) return;
  lanMeshActive = on;
  broadcastAutoSyncChanged();
}

/** 给判据用：现在的状态（只读，不许拿它当"真相"另存一份）。 */
export function isLanMeshActive(): boolean {
  return lanMeshActive;
}

export function effectiveAutoSyncMs(): number {
  const raw = readAutoSyncMs();
  // ★ 2026-09-29（本档）：**设备直连那条路的节拍 = 用户选的「拉取间隔」** ——
  //   不再是"按 `mesh.enabled` 在代码里悄悄换成 5 秒"。两个前提缺一不可：
  //     · 设备直连开着（`lanMeshActive`，由拿到 `lan_status` 的那一处喂进来）；
  //     · 总闸不是「关闭」（`raw > 0`）——**总闸优先**（规格 §9.2）：总闸关了 ⇒
  //       一个字都不自动跑（**含局域网那一档**），面板上那一行也会灰掉。
  //   ⚠️ "轮询必须**无条件**挂着"那条不变式在这一支上仍然成立：`readPullIntervalMs()`
  //      永远 > 0（没设过 ⇒ 默认 5 秒），所以这里不会算出 0。
  if (lanMeshActive && raw > 0) return readPullIntervalMs();
  if (raw > 0) return raw;
  if (!isNearRealtimeEnabled()) return 0;
  // 近实时那一档的**兜底**轮询（真机抓到的现场：`autoSync` 从没写过 ⇒ 裸读是 0）：
  // 设备直连开着 ⇒ 用这条路的节拍；关着 ⇒ 服务端档那条 5 分钟兜底。
  return lanMeshActive ? readPullIntervalMs() : SYNC_REALTIME_FALLBACK_MS;
}

/**
 * 广播"**有效间隔**变了"（`writeAutoSyncMs` 与面板都走这一处，事件名只写一次）。
 *
 * ⚠️ 为什么面板还要**再喊一次**：有效间隔是 `f(间隔, 近实时)` 两个键的函数，而写这两个键是
 * 两步（先 `writeAutoSyncMs`、后 `applyNearRealtime` 落盘）。第一步广播时近实时还是**旧值** ——
 * 「近实时 → 关闭」那一刻就会算成"还开着 ⇒ 挂 5 分钟兜底"，于是用户选了「关闭」却每 5 分钟
 * 自动同步一次。所以两半都落定之后必须再广播一次（面板 `applySyncMode` 里那一句）。
 */
export function broadcastAutoSyncChanged(): void {
  try {
    window.dispatchEvent(new Event(AUTO_SYNC_CHANGED_EVENT));
  } catch {
    /* 没有 window（Node 侧脚本）⇒ 没人订阅，也就不必喊 */
  }
}

/** 写档位并**广播**（面板改档的唯一入口）。 */
export function writeAutoSyncMs(ms: number): void {
  try {
    localStorage.setItem(AUTO_SYNC_KEY, String(ms));
    broadcastAutoSyncChanged();
  } catch {
    /* localStorage 不可用（隐私模式等）⇒ 只影响"记住档位"，不影响本次行为 */
  }
}
