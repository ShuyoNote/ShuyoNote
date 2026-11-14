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
  /**
   * ⭐ 2026-11-11（P0-1b）：差异里「**有远端状态待合并**」的页数 —— 已知噪声（不是异常）。
   * ⚠️ 只由 `shadowScanSpace` 填（`shadowComparePages` 不填，保持纯函数形状不变）。
   */
  differPending?: number;
  /**
   * ⭐ 2026-11-11（P0-1b）：差异里「**没有待合并、却投影 ≠ CRDT**」的页数 —— 待查。
   * ⚠️ 当前没有“写入来源”字段 ⇒ MCP/裁决写入也会落在这里（见 `docs/plans/…status` 的口径说明）。
   */
  differUnexplained?: number;
}

/**
 * 影子比对的**已知归一**（只此一条，⛔ 不放大成"差不多就算相等"）：
 * yjs/编辑器往返会把 `direction: null` 写成 `"ltr"`（Lexical 的默认方向）——
 * 那是**序列化形状**差异，不是内容差异；真实页面若按原样比会 100% 假 differ，影子就没用了。
 * 归一后仍走 canonical（键排序/数组保序）；⛔ `canonicalJson` 本身不加这个宽容（它只是规范化 JSON）。
 */
/**
 * ⭐ **A1 修法 A（owner 2026-11-14 拍）**：影子比对**不参与比较**的元数据键（唯一出处）。
 *
 * 来由（2026-11-14 根因定位）：落盘 block 带 `blockRev`、而 `projectStateToJson` 投影不带
 * ⇒ canonical 必然不同 ⇒ **equal 永远 0**、differ≈全部（7 天观察数据作废）。
 * 修法：比对前**显式忽略**这些键；⛔ 不许用通配/模糊匹配，⛔ 不许在别处再写一份名单。
 * ⚠️ 代价（如实）：这样影子只回答"**内容**是否等价"；`blockRev` 的一致性**不在**影子读数里
 * （投影不携带 rev，当前无法比较）——要测 rev 一致性得走 B 方案（把 rev 纳入投影）。
 */
export const SHADOW_IGNORED_KEYS = ["blockRev"] as const;

/**
 * 已知噪声归一（影子比对专用）：
 * · `direction: null` ↔ `"ltr"`（yjs/编辑器往返的序列化默认值）；
 * · 忽略 `SHADOW_IGNORED_KEYS` 里的元数据键（A1 修法 A）。
 */
function normalizeKnownNoise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeKnownNoise);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if ((SHADOW_IGNORED_KEYS as readonly string[]).includes(k)) continue;
      out[k] = normalizeKnownNoise(v);
    }
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

/**
 * 诊断/判据用：影子比对实际使用的 canonical 形态（含已知归一与元数据忽略）。
 * ⚠️ 只用于**只读诊断与判据**，⛔ 不要把它当"通用 JSON 规范化"（那用 `canonicalJson`）。
 */
export function shadowCanonicalJson(json: string): string | null {
  return canonicalForShadow(json);
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
