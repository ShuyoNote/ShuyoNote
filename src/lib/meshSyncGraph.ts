// ⭐ §13.6 **O1「多设备同步图」—— 数据面第一刀**：把现成的只读读数聚合成
//   「设备节点 ＋ 边（最近一次成功 / 落后多少 / 失败原因）」。
//
// ## 这个文件为什么存在（它替谁承重）
// O1 的目标是「每台设备、每个空间、每条边的**最近一次成功 / 延迟 / 失败原因**」，
// 验收判据是「**3 台设备时能一眼看出哪条边断了**；**每条读数有来源**」。
// 但**今天没有一条命令能直接给出这张图**：
//   · `mesh_watermarks`：只覆盖**当前空间**，逐台只有 `cursor / online / lastOkAgoMs`，
//     且**对端只用序号**（⛔ 没有 `device_id` —— `INV-UI-copy-no-internal-ids`）；
//   · `list_sync_history`：是**空间级**的行（`ws_id / ws_name` ＋ 计数与后端原文），
//     **没有「哪一台」这一维**，也不区分网格/服务端两支；
//   · 逐边「一轮花了多久」：**任何现有读数里都没有**。
// ⇒ 本刀**只做数据面**：不新增命令、不发包、不写库，把上面两支**如实**聚合成图，
//    并把**量不到**的东西逐个写进 `missing`（⛔ 不许拿 `null` 冒充「量过、值是 0」）。
//
// ## 三条纪律（与 `meshDiagnose.ts` 同源）
// 1. **读不到 ≠ 0**：`watermarks` 传 `null`/`undefined` ＝ 这一支没读到（`readable.watermarks=false`），
//    ⛔ 不许当「0 台设备」；历史**空数组** ＝ 真读过、只是没有轮次，两者必须能分辨。
// 2. **不编**：⛔ 不用对端序号去"推"设备身份（序号是按已收水位降序**现算**的，两次读数之间会重排
//    ⇒ 见 `identityBasis: "cursor-ordinal"`）；⛔ 不把**空间级**的失败挂到某台对端边上。
// 3. **脱敏**：⛔ 不含空间名 / 空间 id / 设备号 / 设备名 / 地址 / 公钥 / 条目标题 ——
//    空间只用「空间 N」、对端只用「对端 N」（与 `meshDiagnose.ts` 文件头第 3 条同一张清单）。
//
// ## ⚠️ 本片**故意不接线**（用户可见行为变更需 owner 拍板）
// 所以本文件目前只有纯函数 ＋ 判据（`meshSyncGraph.test.ts`）；将来接线时**只允许**把
// `meshSyncGraph()` 的结果摆出去，⛔ 不许在组件里另算一遍状态。
//
// 判据：`src/lib/meshSyncGraph.test.ts`。

import type { MeshWatermarks } from "./platform/commands";
import { agoText, plainText } from "./diagnoseText";

/**
 * `list_sync_history` 的一行（**结构化**声明：只点本函数真的读的字段）。
 *
 * ⚠️ 为什么不直接用 `CommandMap["list_sync_history"]["result"][number]`：
 * `meshDiagnose.ts` 那张输入类型（O2 的 `SyncHistoryRow`）**故意更窄**（只留判据要的字段），
 * 而真实命令结果在运行期是带 `ws_id` / `ws_name` 的 ⇒ 这里用**可选**字段接两边，
 * 运行期不丢信息、类型上也不逼调用方多抄一层。
 */
export interface SyncHistoryRowLike {
  at: number;
  ok: boolean;
  pushed: number;
  pulled: number;
  message: string;
  /** 该轮明细（只数数量，⛔ 不读 `title`）。 */
  items?: unknown[];
  /** 空间内部 id（⛔ **只用于分组**，绝不写进结果）。 */
  ws_id?: string;
  /** 空间名（⛔ **只在缺 id 时当分组键**，绝不写进结果）。 */
  ws_name?: string;
}

/** 一格读数的来源。`derived:` 前缀 ＝ 由同名命令的读数**算出**来（不是命令直接给的）。 */
export type SyncGraphSource =
  | "mesh_watermarks"
  | "derived:mesh_watermarks"
  | "list_sync_history"
  /** ⭐ 2026-11-19：`lan_status.nearby`（只用来判断"这台在线且服务当前空间"）。 */
  | "lan_status";

/** 一格读数：值 ＋ 来源。`value === null` ⇒ `source === null`（读不到就不许声称有来源）。 */
export interface GraphReadout {
  value: number | boolean | null;
  source: SyncGraphSource | null;
}

/** 四条边的状态。`unknown` ＝ **没有结论**（还没有成功记录／落后读不出来），⛔ 不是"没问题"。 */
export type SyncGraphEdgeStatus = "ok" | "behind" | "down" | "unknown";

/** 图里的一个设备节点（本机 / 对端；⛔ 对端没有真身份，只有序号）。 */
export interface SyncGraphNode {
  /** `self` / `peer-<序号>`（⛔ 不是 `device_id`）。 */
  key: string;
  role: "self" | "peer";
  /** 脱敏安全的显示名（`本机` / `对端 N`）。 */
  label: string;
  /**
   * ⚠️ 这个节点靠什么被认出来：
   * · `self` ＝ 本机（唯一）；
   * · `cursor-ordinal` ＝ **只能是序号** —— `mesh_watermarks` 不含 `device_id`，而序号是按
   *   已收水位降序**现算**的（两次读数之间可能重排）⇒ ⛔ 别把它当稳定键长期记；
   * · ⭐ **2026-11-19**：`online-ordinal` ＝ **在线但还没有任何水位记录**的对端
   *   （只从"附近有几台服务这个空间"推出来的行；同样是序号，⛔ 没有身份）。
   */
  identityBasis: "self" | "cursor-ordinal" | "online-ordinal";
  /** 这一节点的读数来自哪支（读不到 ⇒ `null`）。 */
  source: SyncGraphSource | null;
}

/** 逐台边的那几格读数（⛔ 全部来自 `mesh_watermarks`，没有别的来源）。 */
export interface SyncGraphEdgeReads {
  cursor: GraphReadout;
  localMaxSeq: GraphReadout;
  lag: GraphReadout;
  online: GraphReadout;
  lastOkAgoMs: GraphReadout;
  /** ⛔ 现有读数里**没有**逐边延迟 ⇒ 永远是 `null`（见 `missing`）。 */
  latencyMs: GraphReadout;
}

/** 当前空间里「本机 → 某台对端」的一条边。 */
export interface SyncGraphEdge {
  /** `self->peer-<序号>`（判据按它取，⛔ 不含任何运行时值）。 */
  key: string;
  from: "self";
  to: string;
  /** 这条边的口径：**当前空间**的逐台数据面边。 */
  kind: "peer-current-space";
  status: SyncGraphEdgeStatus;
  /** 为什么是这个状态（脱敏；点名「对端 N」—— 这就是"哪条边断了"）。 */
  reason: string;
  reads: SyncGraphEdgeReads;
  /** ⛔ 这条边**量不到**的格（别让下一刀以为量过）。 */
  missing: string[];
}

/** 一个空间的最近轮次（⛔ 只有序号与读数，没有名字/内部 id）。 */
export interface SyncGraphSpace {
  /** `space-<序号>`（按最近一条记录排序；⛔ 不是 `ws_id`）。 */
  key: string;
  label: string;
  rounds: number;
  okCount: number;
  failCount: number;
  /** 最近一次成功／失败的时刻（ms）；没有 ⇒ `null`。 */
  lastOkAt: number | null;
  lastFailAt: number | null;
  /** 最近一次失败的后端原文（去 Markdown 标记、截断；⛔ 不含条目标题）。 */
  lastFailMessage: string | null;
  source: "list_sync_history";
}

/** 一次聚合的完整结果。 */
export interface MeshSyncGraph {
  at: number;
  /** ⚠️ 这一版只覆盖**当前空间**的逐台边（多空间需求新命令，见 `missing`）。 */
  scope: "current-space";
  nodes: SyncGraphNode[];
  spaces: SyncGraphSpace[];
  edges: SyncGraphEdge[];
  counts: Record<SyncGraphEdgeStatus, number>;
  /** 两支读数各读没读到（⛔ 空数组 ≠ 没读过）。 */
  readable: { watermarks: boolean; history: boolean };
  /** 一句总评（脱敏安全）。 */
  headline: string;
  /** ⛔ 这一版**量不到**的东西（逐条点名；下一刀别以为量过了）。 */
  missing: string[];
}

/** 输入：**只用现成读数**（⛔ 不联网、不发包、不读环境）。 */
export interface MeshSyncGraphInput {
  /** `mesh_watermarks` 的读数；`null`/`undefined` ＝ 这一支没读到。 */
  watermarks?: MeshWatermarks | null;
  /** `list_sync_history` 的读数；`null`/`undefined` ＝ 这一支没读到（`[]` ＝ 读过但没有轮次）。 */
  history?: SyncHistoryRowLike[] | null;
  /** 生成时刻（测试注入；省略＝现在）。 */
  at?: number;
  /**
   * ⭐ **2026-11-19（owner 拍）**：**附近在线、且声明服务当前空间**的台数
   * （来自 `lan_status.nearby` 里 `serves_current === true` 的条目数）。
   *
   * 为什么需要：图只列**有游标行**的对端，而"我拉过它、它当时没有新东西"**不会落游标行**
   * ⇒ 三台在场时图上只出现一台（2026-11-19 真机实测：nearby 2 台、图只 1 行）。
   * ⇒ 这个数用来**补**出"在线但还没有记录"的行（状态 `unknown`，⛔ 不写成"断了"）。
   * ⚠️ 只能做**计数相减**：图里对端只有序号、没有 `device_id`，没法与 `nearby` 逐台对齐
   *   ⇒ 只保证"行数不少于在线台数"，不保证行与设备一一对应（照实写进 `missing`）。
   */
  onlineServingNearby?: number;
}

/** 有限数才当读数（⛔ 不把 `NaN`／字符串当 0）。 */
function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function readout(value: number | boolean | null, source: SyncGraphSource | null): GraphReadout {
  return { value: value === null ? null : value, source: value === null ? null : source };
}

/** 一条逐台边的四档状态（纯判据；`lag === null` ⇒ 没有结论，⛔ 不判已齐）。 */
function peerStatus(online: boolean | null, lag: number | null): SyncGraphEdgeStatus {
  if (online === null) return "unknown";
  if (online === false) return "down";
  if (lag === null) return "unknown";
  return lag > 0 ? "behind" : "ok";
}

/** 逐台边的那句人话（**必须**点名「对端 N」—— 用户要能看出是哪条边）。 */
function peerReason(index: number, status: SyncGraphEdgeStatus, reads: SyncGraphEdgeReads): string {
  const cursor = reads.cursor.value as number | null;
  const local = reads.localMaxSeq.value as number | null;
  const lag = reads.lag.value as number | null;
  const ago = agoText(reads.lastOkAgoMs.value as number | null);
  const got = cursor === null || local === null ? "水位读不出来" : `已收 ${cursor} / 本机 ${local}`;
  if (status === "unknown") {
    if (reads.online.value === null) {
      return `对端 ${index}：还没有成功记录 ⇒ 在线/落后都未知（⛔ 不当离线）`;
    }
    return `对端 ${index}：${got}，但已收水位读不出来 ⇒ 落后多少未知（⛔ 不判已齐）`;
  }
  if (status === "down") {
    return `对端 ${index}：离线（后端按在线窗口判定；最近一次成功：${ago}）`;
  }
  const tail = `；最近成功：${ago}`;
  if (status === "behind") {
    return `对端 ${index}：在线，${got}（落后 ${lag}）${tail}`;
  }
  return `对端 ${index}：在线，${got}（已齐）${tail}`;
}

/** 把两支读数各拼一句（脱敏）。 */
function headlineOf(
  counts: Record<SyncGraphEdgeStatus, number>,
  peers: number,
  readable: { watermarks: boolean; history: boolean },
  historyRows: number,
  spaces: number,
): string {
  const spacePart = readable.watermarks
    ? `当前空间 ${peers} 台：已齐 ${counts.ok} · 落后 ${counts.behind} · 断 ${counts.down} · 未知 ${counts.unknown}`
    : "当前空间：水位读不到（⛔ 不是「一台都没有」）";
  let historyPart: string;
  if (!readable.history) {
    historyPart = "同步历史读不到";
  } else if (historyRows === 0) {
    historyPart = "同步历史里还没有轮次";
  } else {
    historyPart = `同步历史 ${spaces} 个空间 / ${historyRows} 轮`;
  }
  return `${spacePart}；${historyPart}`;
}

/** 空间分组用的内部键 —— **只在本函数内用**，⛔ 绝不写进结果（结果只有「空间 N」）。 */
function spaceKeyOf(row: SyncHistoryRowLike): string {
  const id = String(row.ws_id ?? "").trim();
  if (id) return id;
  const name = String(row.ws_name ?? "").trim();
  if (name) return name;
  // 两格都没有（窄形状的调用方）：**并到一个桶**，因为分不开。
  // ⛔ 不按行号拆成 N 个"空间" —— 那等于替它们编出互相独立的关系。
  return "__no_space_identity";
}

/** 逐空间聚合最近轮次（只读计数与后端原文；⛔ 不读 `items[].title`）。
 *
 * ⚠️ 边界（如实记）：`message` 是**后端原文**，按 O2 的口径原样进图（只去 `**`、截断 200 字）——
 *    如果后端某天把条目标题写进了那句话，本函数拦不住。⛔ 那不等于"读标题"：本函数一行都没读过
 *    `items[].title`（判据 `meshSyncGraph.test.ts` 的脱敏场景用 `items[].title` 当探针）。
 */
function spacesOf(rows: SyncHistoryRowLike[]): SyncGraphSpace[] {
  interface Acc {
    rounds: number;
    okCount: number;
    failCount: number;
    lastOkAt: number | null;
    lastFailAt: number | null;
    lastFailMessage: string | null;
    latestAt: number;
  }
  const accs = new Map<string, Acc>();
  rows.forEach((row) => {
    const key = spaceKeyOf(row);
    const at = numOrNull(row.at) ?? 0;
    const acc: Acc = accs.get(key) ?? {
      rounds: 0,
      okCount: 0,
      failCount: 0,
      lastOkAt: null,
      lastFailAt: null,
      lastFailMessage: null,
      latestAt: 0,
    };
    acc.rounds += 1;
    acc.latestAt = Math.max(acc.latestAt, at);
    if (row.ok === true) {
      acc.okCount += 1;
      acc.lastOkAt = acc.lastOkAt === null ? at : Math.max(acc.lastOkAt, at);
    } else {
      acc.failCount += 1;
      // 最近一次失败的那句原文才留下（旧的那句不覆盖新的）。
      if (acc.lastFailAt === null || at >= acc.lastFailAt) {
        acc.lastFailAt = at;
        const msg = plainText(String(row.message ?? "")).trim().slice(0, 200);
        acc.lastFailMessage = msg || null;
      }
    }
    accs.set(key, acc);
  });
  return [...accs.values()]
    .sort((a, b) => b.latestAt - a.latestAt)
    .map((acc, i) => ({
      key: `space-${i + 1}`,
      label: `空间 ${i + 1}`,
      rounds: acc.rounds,
      okCount: acc.okCount,
      failCount: acc.failCount,
      lastOkAt: acc.lastOkAt,
      lastFailAt: acc.lastFailAt,
      lastFailMessage: acc.lastFailMessage,
      source: "list_sync_history" as const,
    }));
}

/**
 * 把 `mesh_watermarks` ＋ `list_sync_history` 聚合成「多设备同步图」。**纯函数**（时间可注入）。
 *
 * ⚠️ 这一版只有**当前空间**的逐台边；空间那一侧只有**轮次级**读数（见 `missing`）。
 */
export function meshSyncGraph(input?: MeshSyncGraphInput): MeshSyncGraph {
  const at = input?.at ?? Date.now();
  const wm = input?.watermarks ?? null;
  const watermarksReadable = wm !== null && typeof wm === "object";
  const rows = input?.history;
  const historyReadable = Array.isArray(rows);
  const historyRows = historyReadable ? (rows as SyncHistoryRowLike[]) : [];
  const spaces = historyReadable ? spacesOf(historyRows) : [];

  const localMaxSeq = watermarksReadable ? numOrNull((wm as MeshWatermarks).localMaxSeq) : null;
  const peerRowsRaw = watermarksReadable ? (wm as MeshWatermarks).peers : [];
  const peerRows = Array.isArray(peerRowsRaw) ? peerRowsRaw : [];

  const nodes: SyncGraphNode[] = [
    {
      key: "self",
      role: "self",
      label: "本机",
      identityBasis: "self",
      source: watermarksReadable ? "mesh_watermarks" : null,
    },
  ];
  const edges: SyncGraphEdge[] = [];
  const counts: Record<SyncGraphEdgeStatus, number> = { ok: 0, behind: 0, down: 0, unknown: 0 };

  peerRows.forEach((p, i) => {
    const index = numOrNull(p.index);
    const label = index !== null && index >= 1 ? Math.floor(index) : i + 1;
    const key = `peer-${label}`;
    nodes.push({
      key,
      role: "peer",
      label: `对端 ${label}`,
      identityBasis: "cursor-ordinal",
      source: "mesh_watermarks",
    });

    const cursor = numOrNull(p.cursor);
    const online = typeof p.online === "boolean" ? p.online : null;
    const lastOkAgoMs = numOrNull(p.lastOkAgoMs);
    const lagRaw = cursor !== null && localMaxSeq !== null ? localMaxSeq - cursor : null;
    // 落后不许是负数（已收超过本机是本机的口径问题，不是"落后 −5"）。
    const lag = lagRaw === null ? null : Math.max(0, lagRaw);

    const reads: SyncGraphEdgeReads = {
      cursor: readout(cursor, "mesh_watermarks"),
      localMaxSeq: readout(localMaxSeq, "mesh_watermarks"),
      lag: readout(lag, "derived:mesh_watermarks"),
      online: readout(online, "mesh_watermarks"),
      lastOkAgoMs: readout(lastOkAgoMs, "mesh_watermarks"),
      latencyMs: readout(null, null),
    };
    const status = peerStatus(online, lag);
    const missing: string[] = ["逐边延迟（每轮耗时） —— 现有读数里没有这一格"];
    if (lag === null) {
      missing.push("落后多少 —— 已收水位或本机高水位不是有效数字");
    }
    counts[status] += 1;
    edges.push({
      key: `self->${key}`,
      from: "self",
      to: key,
      kind: "peer-current-space",
      status,
      reason: peerReason(label, status, reads),
      reads,
      missing,
    });
  });

  // ⭐ **2026-11-19（owner 拍）**：把"在线、服务这个空间、但还没有任何水位记录"的对端**也列出来**。
  //   只做**计数相减**（图里只有序号，没法与 `nearby` 的 device_id 逐台对齐）⇒ 只保证行数不少于在线台数。
  //   ⛔ 状态写 `unknown`、⛔ 绝不写"断了"：没记录 ≠ 坏了。
  const nearbyOnline = Math.max(0, Math.floor(numOrNull(input?.onlineServingNearby) ?? 0));
  const extras = Math.max(0, nearbyOnline - peerRows.length);
  for (let i = 0; i < extras; i += 1) {
    const label = peerRows.length + i + 1;
    const key = `peer-${label}`;
    nodes.push({
      key,
      role: "peer",
      label: `对端 ${label}`,
      identityBasis: "online-ordinal",
      source: "lan_status",
    });
    const reads: SyncGraphEdgeReads = {
      cursor: readout(null, null),
      localMaxSeq: readout(localMaxSeq, "mesh_watermarks"),
      lag: readout(null, null),
      online: readout(true, "lan_status"),
      lastOkAgoMs: readout(null, null),
      latencyMs: readout(null, null),
    };
    counts.unknown += 1;
    edges.push({
      key: `self->${key}`,
      from: "self",
      to: key,
      kind: "peer-current-space",
      status: "unknown",
      reason: `对端 ${label}：在线（附近能看到它，它也说服务这个空间），但还没有收到过它的数据 ⇒ 没有水位/最近成功记录（⛔ 不是「断了」）`,
      reads,
      missing: ["这条边的水位与最近成功 —— 还没收到过它的数据，所以一个字都没有（⛔ 不编 0）"],
    });
  }

  const missing: string[] = [
    "逐边延迟（每轮耗时） —— `mesh_watermarks` 只有「最近一次成功多久」，没有逐轮耗时",
    "逐边失败原因 —— 同步历史是**空间级**行，没有「哪一台」这一维 ⇒ ⛔ 不许把空间级失败挂到某台对端上",
    "多空间 × 每台设备的水位矩阵 —— `mesh_watermarks` 只读当前空间（逐空间互不相通），需要新命令（本片不新增）",
  ];
  if (!watermarksReadable) {
    missing.push("当前空间水位矩阵 —— `mesh_watermarks` 这一次读不到（⛔ 不等于 0 台）");
  }
  if (!historyReadable) {
    missing.push("逐空间轮次 —— `list_sync_history` 这一次读不到（⛔ 不等于没有失败）");
  }

  return {
    at,
    scope: "current-space",
    nodes,
    spaces,
    edges,
    counts,
    readable: { watermarks: watermarksReadable, history: historyReadable },
    headline: headlineOf(
      counts,
      edges.length,
      { watermarks: watermarksReadable, history: historyReadable },
      historyRows.length,
      spaces.length,
    ),
    missing,
  };
}

/**
 * 图的纯文本形态（给未来的诊断包/工单用；⛔ 现在不接任何界面）。
 *
 * ⛔ 与结构同口径脱敏：只有「对端 N / 空间 N」、读数、原因码，没有空间名/设备号/地址/标题。
 */
/**
 * ⭐ **O1 面板第一刀（owner 2026-11-18 拍「在同步面板上真画出来」）**：
 * 一条**给界面直接摆**的行（词、颜色档、读数都在这儿定好 —— ⛔ 组件里不许再判 `online`/`lag`）。
 */
export interface SyncGraphRow {
  /** `self->peer-N`（与边上同一个键）。 */
  key: string;
  /** 显示名（`对端 N`；⛔ 不含设备号/设备名）。 */
  label: string;
  status: SyncGraphEdgeStatus;
  /** 用户看到的那两个词（已齐 / 落后 / 断了 / 未知；⛔ 不显示英文码）。 */
  statusText: string;
  /** 颜色档（与 `DiagnoseLevel` 同名词汇；`unknown` ＝ 没有结论）。 */
  level: "ok" | "warn" | "bad" | "unknown";
  /** 一行读数（已收/本机/落后 ＋ 最近成功；⛔ 不含地址/设备号）。 */
  detail: string;
}

/** 四档状态 → 界面上的两个词（判据按它取，⛔ 别在组件里另写一套）。 */
export const SYNC_GRAPH_STATUS_TEXT: Record<SyncGraphEdgeStatus, string> = {
  ok: "已齐",
  behind: "落后",
  down: "断了",
  unknown: "未知",
};

const STATUS_LEVEL: Record<SyncGraphEdgeStatus, SyncGraphRow["level"]> = {
  ok: "ok",
  behind: "warn",
  down: "bad",
  unknown: "unknown",
};

/**
 * 把图里**当前空间**的逐台边翻成界面行。**纯函数**（⛔ 不读环境、不读时钟）。
 *
 * ⚠️ 只出逐台边（空间轮次由「同步历史」那块负责，⛔ 界面上不重复摆两遍）。
 */
export function syncGraphRows(g: MeshSyncGraph): SyncGraphRow[] {
  return g.edges.map((e) => {
    const cursor = e.reads.cursor.value;
    const local = e.reads.localMaxSeq.value;
    const lag = e.reads.lag.value;
    const got =
      cursor === null && local === null
        ? "已收/本机=未读到"
        : cursor === null
          ? // ⭐ 2026-11-19：本机高水位知道、对端水位不知道（在线但还没收到过）—— ⛔ 不写"未读到"糊成一片
            `已收=未读到 / 本机 ${local}（落后未知）`
          : local === null
            ? `已收 ${cursor} / 本机=未读到（落后未知）`
            : `已收 ${cursor} / 本机 ${local}` +
              (lag === null ? "（落后未知）" : `（落后 ${lag}）`);
    return {
      key: e.key,
      label: e.to.replace("peer-", "对端 "),
      status: e.status,
      statusText: SYNC_GRAPH_STATUS_TEXT[e.status],
      level: STATUS_LEVEL[e.status],
      detail: `${got} · 最近成功 ${agoText(e.reads.lastOkAgoMs.value as number | null)}`,
    };
  });
}

/**
 * ⭐ **O1 接线（owner 2026-11-18 拍：进「连接体检」的复制诊断包）**：
 * 图的**诊断包段落**（缩进行；由 `meshDiagnosticText` 原样拼进去）。
 * （同日第二刀：面板上也摆了这张图 —— 那一支走上面的 `syncGraphRows()`，⛔ 不是这里。）
 *
 * ⚠️ 与 `meshSyncGraphText` 的差别是**故意的**：
 * · 这里不给标题/时间（诊断包自己有），也不列 `missing` 全文（那段话里有命令名与"水位矩阵"这类
 *   会跟 O2 已有的两段标题撞车的词）⇒ 只留一句「本包没有」；
 * · 一行边一行空间，贴进工单能一眼看出断的是哪条。
 */
export function meshSyncGraphDiagnosticLines(g: MeshSyncGraph): string[] {
  const lines: string[] = [
    "多设备同步图（当前空间逐台 ＋ 各空间轮次；脱敏：不含空间名、空间号、设备号、设备名、条目标题）",
    `  结论：${g.headline}`,
  ];
  if (g.edges.length === 0) {
    lines.push(
      g.readable.watermarks
        ? "  逐台：这一轮 0 台对端（真读数）"
        : "  逐台：这一次读不到（⛔ 不等于 0 台）",
    );
  }
  for (const e of g.edges) {
    const cursor = e.reads.cursor.value;
    const local = e.reads.localMaxSeq.value;
    const lag = e.reads.lag.value;
    const tail =
      cursor === null || local === null
        ? "已收/本机=未读到"
        : `已收 ${cursor} / 本机 ${local} · 落后 ${lag ?? "未读到"}`;
    lines.push(
      `  ${e.to.replace("peer-", "对端 ")}：${e.status} · ${tail}` +
        ` · 最近成功=${agoText(e.reads.lastOkAgoMs.value as number | null)}`,
    );
    lines.push(`    原因：${plainText(e.reason)}`);
  }
  lines.push("  各空间轮次：");
  if (!g.readable.history) {
    lines.push("    这一次读不到（⛔ 不等于没有失败）");
  } else if (g.spaces.length === 0) {
    lines.push("    历史里还没有轮次");
  }
  for (const s of g.spaces) {
    const when =
      s.lastFailAt === null ? "还没有失败记录" : `最近失败 ${agoText(g.at - s.lastFailAt)}`;
    lines.push(
      `    ${s.label}：${s.rounds} 轮（成功 ${s.okCount} / 失败 ${s.failCount}）；${when}` +
        (s.lastFailMessage ? ` · 原文：${s.lastFailMessage}` : ""),
    );
  }
  lines.push("  ⛔ 本包没有：逐边延迟（每轮耗时）、逐边失败原因（历史是空间级，不归属到某台）");
  return lines;
}

/**
 * 图的纯文本形态（独立版；⛔ 现在不接任何界面，诊断包用的是上面那个 `…DiagnosticLines`）。
 *
 * ⛔ 与结构同口径脱敏：只有「对端 N / 空间 N」、读数、原因码，没有空间名/设备号/地址/标题。
 */
export function meshSyncGraphText(g: MeshSyncGraph): string {
  const lines: string[] = [
    "多设备同步图（当前空间逐台 ＋ 各空间最近轮次；不含空间名、空间号、设备号、设备名、条目标题）",
    `时间：${new Date(g.at).toLocaleString("zh-CN")}`,
    `结论：${g.headline}`,
    "",
    "设备：",
    ...g.nodes.map(
      (n) =>
        `  ${n.label}（${n.identityBasis === "self" ? "本机" : "只能用序号指代，不是稳定设备号"}）` +
        ` · 来源=${n.source ?? "未读到"}`,
    ),
    "",
    ...meshSyncGraphDiagnosticLines(g),
    "",
    "这一版量不到：",
    ...g.missing.map((m) => `  - ${m}`),
  ];
  return lines.join("\n");
}
