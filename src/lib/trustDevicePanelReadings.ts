// **信任设备那一屏的读数来源**（task 派单：把 `TrustDevicePanel` 挂到同步面板上）。
//
// ## 为什么单独放一个**纯**模块
// 这一轮后端那几条读数命令**还没到位** ✗（Lead 在写 `src-tauri/**`）⇒ 那四条读数一律要**如实给
// `{ kind: "unavailable", reason }`** ✓ —— ⛔ 不许编 0、⛔ 不许编假数 ✗
// （`TrustDevicePanel.tsx:7-8` 逐字：「`unavailable` 在界面上**只许说"读不到"** —— ⛔ **绝不许退化成 0** ✗：
//   「0 条重合」是**一个结论**，「读不到」是**没有结论** ✓，这两件事在界面上**长得必须不一样** ✓」）。
// ⇒ 把"给哪几条读数"收成一个**纯函数** ✓ ⇒ 判据可以直接测它（⭐ "⛔ 不编 0"因此**机器可判** ✓，
//   而不是只靠读 SyncPanel 的源码看看像不像 ✓）。
//
// ⭐ **2026-10-11（任务 B）**：⭐ 多了第五格 `trustState` ✗ —— ⭐ 它是**真读数** ✓（后端 `mesh_trust_state` ✓，
//   见 [`readTrustState`] ✓），而不再"一律读不到" ✓；⭐ 同一把尺照旧 ✗：读不到 ⇒ **如实说读不到** ✓
//   （⛔ 不许编一个"还没开始" ✗ —— 那也是一个**结论** ✓）。
//
// ⚠️ 本模块**只 `import type`**（⛔ 不在运行时拉起那个组件 ✗）⇒ 单测里引它很轻 ✓。

import type { MeshTrustStateView } from "./platform/commands";
// ⭐ **2026-10-14（owner 拍「去掉孤儿组件」）** ✗：`TrustDevicePanel.tsx` **已删** ✓（它今天先丢了挂载点、
//   现在整份组件也删了 ✓）⇒ ⭐ 读数形态那两个类型**搬进本模块** ✓（原本住在那组件里 ✓）。
//   ⛔ 一处也没改形状 ✗：`Reading<T>` 的两种判别式一字未动 ✓，5 个键名一字未动 ✓（判据钉着它们 ✓）。

/** ⭐ 点「信任这台设备」＝ **一端点就通**（owner 拍**甲** ✓）⇒ 一条命令一条空间 ✓。
 *  ⚠️ 名字按 Lead 给的写；他落地时会喊我确认（⛔ 我先不猜参数名之外的形态 ✗）。 */
export const MESH_TRUST_BEGIN_COMMAND = "mesh_trust_begin";

/** ⭐⭐ **2026-10-17**：⭐ **只开一轮比对** ✗ —— ⭐ 生成这一轮的 `trust_ask` ✓，⛔ 不登记信任 ✓。
 *  ⚠️ 为什么需要它：比对码要**在登记之前**看到（⭐ 码 ＝ f(本机公钥, 对面公钥, trust_ask) ✓），
 *  而 `trust_ask` 原来只在 `mesh_trust_begin` 里生成 ⇒ ⭐ 死锁（owner 真机："点接入了，也没有（码）" ✓）。
 *  ⇒ 点「接入」调它 ⇒ 码可读 ✓；点「码对得上，确认」才调 `mesh_trust_begin` ⇒ 登记 ✓。 */
export const MESH_TRUST_PREPARE_COMMAND = "mesh_trust_prepare";

/** ⭐ **2026-10-11（任务 B）：读"信任走到哪一步"** ✗ —— ⭐ 只读 ✓（⛔ 一个字节都不写 ✗）。 */
export const MESH_TRUST_STATE_COMMAND = "mesh_trust_state";

/** 这一轮四条读数**统一**给的原因（⭐ 一句人话，界面上会原样显示给用户 ✓）。 */
export const TRUST_READINGS_UNAVAILABLE_REASON =
  "后端这几条读数还没到位（正在补：可接入空间／本地空间／重合读数／设备数字码）";

/** 一处读数：**拿不到就说拿不到** —— ⛔ 不许拿 0 冒充「没有」✓。（⭐ 从已删的 `TrustDevicePanel.tsx` 原样搬来 ✓） */
export type Reading<T> =
  | { kind: "ok"; value: T }
  | { kind: "unavailable"; reason: string };

/**
 * ⭐ 那一屏的读数形态（四条后端读数 ＋ 信任状态 ✓：5 个键名**一字没动** ✓ —— 判据钉着它们 ✓）。
 *
 * ⚠️ **2026-10-14**：原来是 `Pick<TrustDevicePanelProps, …>` ✗ —— 而那个 props 类型住在**已删**的组件里 ✓
 * ⇒ ⭐ 这里改成**写死形状** ✓（载荷类型也按原样内联搬过来 ✓，⛔ 一个字没改语义 ✗）。
 */
export type TrustDeviceReadings = {
  attachOffer: Reading<{ id: string; name: string; kind: "personal" | "team" | "" }[]>;
  localSpaces: Reading<{ id: string; name: string }[]>;
  mergeOverlap: Reading<{ mergedCount: number; unmergedOverlapCount: number }>;
  deviceCode: Reading<{ code: string; verified: boolean }>;
  trustState: Reading<MeshTrustStateView>;
};

/**
 * ⭐ **读一次信任状态** ✗（⭐ "信任走到哪一步" ✓ —— ⭐ 它**是**后端算的那一格 ✓，⛔ 界面不许自己猜 ✗）。
 *
 * ⚠️ **`invoke` 由调用方注入** ✗：这样本模块**不拉起平台层** ✓ ⇒ 判据可以直接喂一个假的 invoke
 *    把"读不到 ⇒ 如实说读不到"钉住 ✓（⛔ 不编 `idle` ✗ —— 「还没开始」是**一个结论** ✓，
 *    与「读不到」在界面上**长得必须不一样** ✓，与那四条读数同一条口径 ✓）。
 */
export async function readTrustState(
  invoke: (cmd: string) => Promise<unknown>,
): Promise<Reading<MeshTrustStateView>> {
  try {
    const raw = (await invoke(MESH_TRUST_STATE_COMMAND)) as MeshTrustStateView | null;
    // ⚠️ 形状不对（缺 `state`）⇒ ⭐ 当"读不到" ✗，⛔ 不拿它凑一个 `idle` 出来 ✓。
    if (!raw || typeof raw.state !== "string" || raw.state.trim() === "") {
      return { kind: "unavailable", reason: "后端回的那一格没有说走到哪一步" };
    }
    return {
      kind: "ok",
      value: {
        state: raw.state,
        message: typeof raw.message === "string" ? raw.message : "",
        active: raw.active === true,
        pending: typeof raw.pending === "number" && Number.isFinite(raw.pending) ? raw.pending : 0,
      },
    };
  } catch (e) {
    // ⭐ 失败**照实报** ✓（⛔ 不假装"还没开始" ✗）—— 非桌面端走到这里就是这条路 ✓。
    return { kind: "unavailable", reason: `没读到（${String(e)}）` };
  }
}

/**
 * ⭐ **如实给"读不到"**（⛔ 不编 0 ✗）：**全部**是 `unavailable` ✓，每条都带**同一个人话原因** ✓。
 *
 * ⚠️ 这个函数的**唯一职责**就是这个 —— 哪天后端命令到位了，**改这里**（换成真读数 ✓），
 *    而 `SyncPanel` 那边一个字都不用动 ✓。
 *
 * ⚠️ `trustState` **也在这里默认"读不到"** ✗（⛔ 不给它编一个 `idle` ✗）—— 调用点（`SyncPanel`）
 *    读到真读数之后**覆盖**它 ✓（`readTrustState` ✓）。
 */
export function unavailableTrustDeviceReadings(
  reason: string = TRUST_READINGS_UNAVAILABLE_REASON,
): TrustDeviceReadings {
  return {
    attachOffer: { kind: "unavailable", reason },
    localSpaces: { kind: "unavailable", reason },
    mergeOverlap: { kind: "unavailable", reason },
    deviceCode: { kind: "unavailable", reason },
    trustState: { kind: "unavailable", reason },
  };
}
