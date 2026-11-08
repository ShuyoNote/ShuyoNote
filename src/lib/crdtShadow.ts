// ⭐ P3-3a 第一小步（task-51）：CRDT **影子比对**纯函数（不接 UI/命令）。
//
// 目的：把**落盘正文 JSON** 与该页 CRDT 状态的**投影**做规范化比较，先回答
// "这两份说的是不是同一件事" —— 只回**计数与 page id**（⛔ 不回正文），供将来的诊断命令/7 天闸用。
//
// 口径（三项都不抛）：
// 1. **canonical**：JSON 解析 → 递归**键排序**（对象键无关顺序）→ **数组保序**；
//    空串/坏 JSON ⇒ `null`（"读不懂"不是"相等"，也不是崩溃）；
// 2. **无状态/空字节/坏落盘 JSON/投影失败** ⇒ **不可比**（单独计数，⛔ 不计成 differ）；
// 3. 比对只做**字符串相等**（canonical 之后），⛔ 不做模糊匹配、⛔ 不猜"大概是同一页"。
//
// ⚠️ 影子比对**必须**在 WebView/vitest 里做（Node 侧拉编辑器节点表会炸 —— ADR §3.2 Step 1）：
// 本文件的投影来自 `yDocBridge.projectStateToJson`（那一层是"落盘 JSON ⇄ ydoc"的**唯一实现**）。

import { projectStateToJson } from "./crdt/yDocBridge";

/** 单个投影比较的结论（失败/不可比都给得出原因，方便诊断）。 */
export type ShadowReason =
  | "no_state"
  | "empty_state"
  | "bad_stored_json"
  | "projection_failed"
  | "differ";

export interface ShadowProjectionResult {
  equal: boolean;
  reason?: ShadowReason;
  /** 落盘 JSON 的 canonical 形态（坏 JSON 时缺省）。 */
  storedCanonical?: string;
  /** 状态投影的 canonical 形态（不可比/投影失败时缺省）。 */
  projectedCanonical?: string;
}

export interface ShadowRowsResult {
  /** 行总数（含不可比）。 */
  total: number;
  /** 有**非空** CRDT 状态的行数（不含空字节）。 */
  withState: number;
  /** 投影与落盘一致的行数。 */
  equal: number;
  /** 两边都可比但**不相等**的行数。 */
  differ: number;
  /** 不可比：无状态/空字节/坏落盘 JSON/投影失败（⛔ 不算 differ）。 */
  uncomparable: number;
  /** **只**给不一致的 page id（⛔ 不含正文；顺序＝输入顺序）。 */
  differPageIds: string[];
}

/**
 * 影子比对的**已知归一**（只此一条，⛔ 不放大成"差不多就算相等"）：
 * yjs/编辑器往返会把 `direction: null` 写成 `"ltr"`（Lexical 的默认方向）——
 * 那是**序列化形状**差异，不是内容差异；真实页面若按原样比会 100% 假 differ，影子就没用了。
 * 归一后仍走 canonical（键排序/数组保序）；⛔ `canonicalJson` 本身不加这个宽容（它只是规范化 JSON）。
 */
function normalizeKnownNoise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeKnownNoise);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = normalizeKnownNoise(v);
    if ("direction" in out && out.direction === null) out.direction = "ltr";
    return out;
  }
  return value;
}

/** 影子比对专用 canonical（canonicalJson ＋ 已知归一）；坏输入 ⇒ null。 */
function canonicalForShadow(json: string): string | null {
  const text = typeof json === "string" ? json.trim() : "";
  if (!text) return null;
  try {
    return JSON.stringify(canonicalize(normalizeKnownNoise(JSON.parse(text))));
  } catch {
    return null;
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) out[key] = canonicalize(obj[key]);
    return out;
  }
  return value;
}

/**
 * 规范化 JSON：解析 → 递归键排序（对象）/保序（数组）→ 重新序列化。
 * 空串/纯空白/不可解析 ⇒ `null`（⛔ 不抛、⛔ 不返回 "{}" 之类假值）。
 */
export function canonicalJson(json: string): string | null {
  const text = typeof json === "string" ? json.trim() : "";
  if (!text) return null;
  try {
    return JSON.stringify(canonicalize(JSON.parse(text)));
  } catch {
    return null;
  }
}

/**
 * 一页的影子比对：落盘 `storedJson` vs `state` 的投影（`projectStateToJson`）。
 * **不抛**：状态缺失/空字节/坏 JSON/投影失败 ⇒ `equal:false` ＋ `reason`（不可比）。
 */
export function shadowCompareProjection(
  storedJson: string,
  state: Uint8Array | null | undefined,
): ShadowProjectionResult {
  if (!state || state.length === 0) {
    return { equal: false, reason: state ? "empty_state" : "no_state" };
  }
  const storedCanonical = canonicalForShadow(storedJson);
  if (storedCanonical === null) {
    return { equal: false, reason: "bad_stored_json" };
  }
  let projectedCanonical: string | null;
  try {
    projectedCanonical = canonicalForShadow(projectStateToJson(state));
  } catch {
    return { equal: false, reason: "projection_failed", storedCanonical };
  }
  if (projectedCanonical === null) {
    return { equal: false, reason: "projection_failed", storedCanonical };
  }
  if (storedCanonical === projectedCanonical) {
    return { equal: true, storedCanonical, projectedCanonical };
  }
  return { equal: false, reason: "differ", storedCanonical, projectedCanonical };
}

/**
 * 多页影子比对（**脱敏**）：只回计数与 `differPageIds`，⛔ 正文/JSON 一个字节都不带出去。
 *
 * `readState` 返回 `null`/空字节 ⇒ 不可比；它自己抛错 ⇒ 该行不可比（⛔ 不让一页坏掉整批）。
 */
export function shadowCompareRows(
  rows: ReadonlyArray<{ id: string; json: string }>,
  readState: (id: string) => Uint8Array | null | undefined,
): ShadowRowsResult {
  const out: ShadowRowsResult = {
    total: 0,
    withState: 0,
    equal: 0,
    differ: 0,
    uncomparable: 0,
    differPageIds: [],
  };
  for (const row of rows) {
    out.total += 1;
    let state: Uint8Array | null | undefined;
    try {
      state = readState(row.id);
    } catch {
      out.uncomparable += 1;
      continue;
    }
    if (!state || state.length === 0) {
      out.uncomparable += 1;
      continue;
    }
    out.withState += 1;
    const cmp = shadowCompareProjection(row.json, state);
    if (cmp.equal) {
      out.equal += 1;
    } else if (cmp.reason === "differ") {
      out.differ += 1;
      out.differPageIds.push(row.id);
    } else {
      // 有状态但落盘 JSON 坏 / 投影炸 ⇒ 仍算"不可比"（⛔ 不诬告成 differ）。
      out.uncomparable += 1;
    }
  }
  return out;
}
