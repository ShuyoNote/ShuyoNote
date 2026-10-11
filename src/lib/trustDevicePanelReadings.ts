// **信任设备那一屏的读数来源**（task 派单：把 `TrustDevicePanel` 挂到同步面板上）。
//
// ## 为什么单独放一个**纯**模块
// 这一轮后端那几条读数命令**还没到位** ✗（Lead 在写 `src-tauri/**`）⇒ 四条读数一律要**如实给
// `{ kind: "unavailable", reason }`** ✓ —— ⛔ 不许编 0、⛔ 不许编假数 ✗
// （`TrustDevicePanel.tsx:7-8` 逐字：「`unavailable` 在界面上**只许说"读不到"** —— ⛔ **绝不许退化成 0** ✗：
//   「0 条重合」是**一个结论**，「读不到」是**没有结论** ✓，这两件事在界面上**长得必须不一样** ✓」）。
// ⇒ 把"给哪四条读数"收成一个**纯函数** ✓ ⇒ 判据可以直接测它（⭐ "⛔ 不编 0"因此**机器可判** ✓，
//   而不是只靠读 SyncPanel 的源码看看像不像 ✓）。
//
// ⚠️ 本模块**只 `import type`**（⛔ 不在运行时拉起那个组件 ✗）⇒ 单测里引它很轻 ✓。

import type { TrustDevicePanelProps } from "../components/TrustDevicePanel";

/** ⭐ 点「信任这台设备」＝ **一端点就通**（owner 拍**甲** ✓）⇒ 一条命令一条空间 ✓。
 *  ⚠️ 名字按 Lead 给的写；他落地时会喊我确认（⛔ 我先不猜参数名之外的形态 ✗）。 */
export const MESH_TRUST_BEGIN_COMMAND = "mesh_trust_begin";

/** 这一轮四条读数**统一**给的原因（⭐ 一句人话，界面上会原样显示给用户 ✓）。 */
export const TRUST_READINGS_UNAVAILABLE_REASON =
  "后端这几条读数还没到位（正在补：可接入空间／本地空间／重合读数／设备数字码）";

/** ⭐ 四条读数的形态（＝ `TrustDevicePanel` 里那四个 `Reading<T>` props ✓）。 */
export type TrustDeviceReadings = Pick<
  TrustDevicePanelProps,
  "attachOffer" | "localSpaces" | "mergeOverlap" | "deviceCode"
>;

/**
 * ⭐ **如实给"读不到"**（⛔ 不编 0 ✗）：四条**全部**是 `unavailable` ✓，每条都带**同一个人话原因** ✓。
 *
 * ⚠️ 这个函数的**唯一职责**就是这个 —— 哪天后端命令到位了，**改这里**（换成真读数 ✓），
 *    而 `SyncPanel` 那边一个字都不用动 ✓。
 */
export function unavailableTrustDeviceReadings(
  reason: string = TRUST_READINGS_UNAVAILABLE_REASON,
): TrustDeviceReadings {
  return {
    attachOffer: { kind: "unavailable", reason },
    localSpaces: { kind: "unavailable", reason },
    mergeOverlap: { kind: "unavailable", reason },
    deviceCode: { kind: "unavailable", reason },
  };
}
