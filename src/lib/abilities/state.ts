// 能力**启停状态**的前端那一半（2026-11-01 · task-14）。
//
// ## 它是什么
// 后端 `ability_states` / `ability_set_enabled` / `ability_uninstall` 的**唯一前端入口**：
// 一份 `<app_data>/abilities-state.json` 的快照，给「能力页」与「Office 导入」那几条入口**共用**。
// ⇒ 于是"禁用"在界面与入口之间只认**一处**状态（⛔ 不是每处各记一个 boolean ✗）。
//
// ## 三条规矩
// 1. ⭐ **读不到 ⇒ 按「全启用」**（fail-open）：与 Rust `abilities::read_state` 同一条口径 ——
//    读不到"禁用偏好"最多是"又能用了"；反过来（fail-closed）会让用户的功能在没有任何解释
//    的情况下失效，而界面又什么都说不出来。⚠️ 真正强制那条（词库查词被拒）在 **Rust** 里，
//    ⛔ 这一层不负责"兜底拦住" ✗ —— 它只回答"现在该不该显示/放行"。
// 2. ⭐ **短 TTL ＋ 手动 `invalidateAbilityStates()`**：能力页改完状态要**立刻**让别的入口看见
//    （Office 导入那条 guard 读的是同一份缓存）；其它调用方不必关心 TTL（默认 2s 内会重读）。
// 3. ⛔ 这里**不做业务判断**：谁该被禁用、禁用对某条入口意味着什么，全在 Rust 与各入口自己那一处
//    （词库在 `src-tauri/src/dictionary.rs`，Office 导入在 `src/lib/office/pathImport.ts`）。
//
// ## 平台事实（如实）
// Web 壳没有能力包落盘（`ability_*` 三条在 `platform/web.ts` 里**如实抛错**）⇒ 这里读到 `null`
// ⇒ 按"全启用"处理 ⇒ 能力页仍可浏览，但点"禁用/卸载"会拿到那句真实错误（⛔ 不假装成功 ✗）。

import { api } from "../api";
import type { AbilityEnabledFlags, AbilityUninstallReport } from "../platform/commands";

export type { AbilityEnabledFlags, AbilityUninstallReport };

/**
 * 能力 id（⭐ 与 Rust `abilities::OFFICE_IMPORT_ID` **逐字一致** —— 改一处必须改另一处）。
 * ⚠️ 界面上那些"这一项被禁用了"的判断都用它，⛔ 别在别处再写一遍字面量 ✗。
 */
export const OFFICE_IMPORT_ABILITY_ID = "office-import";

/** 缓存新鲜度上限（毫秒）。跨入口共用 ⇒ 别太长（用户刚禁用就要生效）。 */
const TTL_MS = 2000;

let cache: { at: number; states: AbilityEnabledFlags[] } | null = null;

/** 丢掉缓存（**改过状态之后必须调**：让别的入口立刻看到新状态）。 */
export function invalidateAbilityStates(): void {
  cache = null;
}

/** 从一份读数里判某个能力是否启用；**没有这一条 ⇒ 启用**（缺省＝启用，与后端同口径）。 */
export function abilityEnabledIn(
  states: AbilityEnabledFlags[] | null | undefined,
  id: string,
): boolean {
  const hit = states?.find((s) => s.id === id);
  return hit ? hit.enabled : true;
}

/** 把命令返回值归一成读数表（形状不对 ⇒ `null`：⛔ 不拿半份猜 ✗）。 */
function normalize(raw: unknown): AbilityEnabledFlags[] | null {
  if (!Array.isArray(raw)) return null;
  const out: AbilityEnabledFlags[] = [];
  for (const item of raw) {
    const o = item as Partial<AbilityEnabledFlags> | null;
    if (!o || typeof o.id !== "string" || typeof o.enabled !== "boolean") continue;
    out.push({ id: o.id, enabled: o.enabled, uninstallable: o.uninstallable === true });
  }
  return out.length > 0 ? out : null;
}

/**
 * 读一份**当前**状态（带 2s 缓存）。
 * ⚠️ 读不到 ⇒ `null`（调用方按"全启用"处理；⛔ 不在这里抛 ✗ —— 这条路径会被导入入口调用）。
 */
export async function loadAbilityStates(
  opts: { force?: boolean } = {},
): Promise<AbilityEnabledFlags[] | null> {
  if (!opts.force && cache && Date.now() - cache.at < TTL_MS) return cache.states;
  try {
    const states = normalize(await api.abilityStates());
    cache = states ? { at: Date.now(), states } : null;
    return states;
  } catch {
    cache = null;
    return null;
  }
}

/** 某个能力现在启用吗？**读不到 ⇒ `true`**（fail-open，见文件头第 1 条）。 */
export async function isAbilityEnabled(id: string): Promise<boolean> {
  return abilityEnabledIn(await loadAbilityStates(), id);
}

/** 启用/停用某个能力：返回**后端落盘之后**的读数，并立刻刷新缓存。错误原样抛出。 */
export async function setAbilityEnabled(
  id: string,
  enabled: boolean,
): Promise<AbilityEnabledFlags[]> {
  const states = normalize(await api.abilitySetEnabled(id, enabled));
  if (!states) {
    // 后端回了但形状不认识 ⇒ 缓存作废（下次重读），但**不假装成功**：把真实读数缺口说出来
    invalidateAbilityStates();
    throw new Error("后端回的能力状态形状不认识 ⇒ 这次改动是否生效未知（重新打开能力页会重读）");
  }
  cache = { at: Date.now(), states };
  return states;
}

/** 卸载某个能力包（**只删** packs/<id>；错误原样抛出 ⇒ 界面显示真实错误）。 */
export async function uninstallAbility(id: string): Promise<AbilityUninstallReport> {
  const report = await api.abilityUninstall(id);
  invalidateAbilityStates();
  return report;
}
