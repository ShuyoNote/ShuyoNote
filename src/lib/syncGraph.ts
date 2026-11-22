// §13.6 O1「多设备同步图」——**数据面第一刀**（只读聚合；⛔ 不做 UI、⛔ 不新增命令）。
//
// 为什么先做数据面：O1 要回答「3 台设备时哪条边断了、每条读数从哪来」。
// 现有读数已经够用，只是散在三处：
//   · `mesh_watermarks`：当前空间的本机高水位 ＋ 逐台已收/在线三态/最近成功多久
//   · `listSyncHistory`：每个空间最近几轮（成功/失败、拉取/推送、后端原文）
//   · `lan_status`：附近设备（本刀暂不用；O1 的"边"先以水位为准）
// 本模块把它们聚成一份**可核的读模型**；UI（后续刀）只负责摆，不在组件里再算一遍。
//
// 脱敏纪律（与 meshDiagnose 同源）：
// · 读模型里的 `spaceName` 只给 UI；`syncGraphText()` ⛔ 不含空间名/设备号/地址/公钥。
// · 缺输入 ≠ 0：读不到就给 `unknown` 并说"读不到"，⛔ 不拿 0 冒充"都正常"。
//
// 判据：`src/lib/syncGraph.test.ts`（水位边/历史轮次/缺输入/脱敏）。

import type { LanStatus, MeshWatermarks } from "./platform/commands";
import type { SyncHistoryRow } from "./meshDiagnose";

/** 一条"边"＝ 当前空间里的一台对端（⛔ 不含 device_id/地址）。 */
export interface SyncGraphEdge {
  /** 稳定键（spaceIndex-peerIndex；⛔ 不含运行时 id）。 */
  key: string;
  spaceIndex: number;
  /** 空间名：只给 UI；⛔ 不进 syncGraphText。 */
  spaceName: string;
  peerIndex: number;
  cursor: number;
  localMaxSeq: number;
  lag: number;
  online: boolean | null;
  lastOkAgoMs: number | null;
  level: "ok" | "warn" | "unknown";
  /** 一句话原因（脱敏安全）。 */
  reason: string;
  /** 下一步做什么（永远有话说）。 */
  next: string;
}

/** 一个空间最近一轮的摘要（来自同步历史；没有记录＝null）。 */
export interface SyncGraphRound {
  at: number;
  ok: boolean;
  pushed: number;
  pulled: number;
  message: string;
}

export interface SyncGraphSpace {
  spaceIndex: number;
  /** 只给 UI。 */
  spaceName: string;
  lastRound: SyncGraphRound | null;
  /** 该空间在本刀里能否给出"设备边"（只有当前空间有 watermarks）。 */
  hasEdges: boolean;
}

export interface SyncGraph {
  spaces: SyncGraphSpace[];
  edges: SyncGraphEdge[];
  counts: { spaces: number; edges: number; ok: number; warn: number; unknown: number };
  /** 一句总评（顶部那行；脱敏安全）。 */
  headline: string;
  /** 生成时刻。 */
  at: number;
}

export interface SyncGraphInput {
  /** 当前空间的水位读数（`mesh_watermarks`）。 */
  watermarks?: MeshWatermarks | null;
  /** 最近同步历史（`listSyncHistory` 的读数，按时间倒序或正序都可）。 */
  history?: SyncHistoryRow[] | null;
  /** 预留：附近设备（本刀不参与成边；只用于"能不能读到发现层"的提示）。 */
  status?: LanStatus | null;
  /** 注入时刻（测试用）。 */
  at?: number;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function agoText(ms: number | null): string {
  if (ms === null) return "还没有成功记录";
  if (ms < 1000) return "刚刚";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒前`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}

/** 每个空间取"最近一轮"（历史行可能按倒序/正序给；按 at 取最大）。 */
function latestRoundPerSpace(rows: SyncHistoryRow[]): Map<string, SyncGraphRound> {
  const out = new Map<string, SyncGraphRound>();
  for (const r of rows) {
    const at = num(r.at);
    if (at <= 0) continue;
    const name = typeof (r as { ws_name?: unknown }).ws_name === "string"
      ? String((r as { ws_name?: unknown }).ws_name)
      : "";
    const key = name || `space-${out.size + 1}`;
    const prev = out.get(key);
    if (prev && prev.at >= at) continue;
    out.set(key, {
      at,
      ok: r.ok === true,
      pushed: num(r.pushed),
      pulled: num(r.pulled),
      message: String(r.message ?? ""),
    });
  }
  return out;
}

/**
 * 聚合同步图读模型。**纯函数**（时间可注入；不读环境、不联网）。
 *
 * 口径：
 * · 有 watermarks ⇒ 为当前空间生成逐台"边"（lag/online/lastOkAgo）；
 * · 有 history ⇒ 每个空间一行"最近一轮"（成功/失败、拉取/推送、后端原文）；
 * · 都没有 ⇒ 空图 ＋ headline 明说"读不到"，⛔ 不假装"没有边＝都正常"。
 */
export function buildSyncGraph(input: SyncGraphInput): SyncGraph {
  const at = input.at ?? Date.now();
  const wm = input.watermarks ?? null;
  const historyRows = Array.isArray(input.history) ? input.history : null;
  const rounds = historyRows ? latestRoundPerSpace(historyRows) : new Map<string, SyncGraphRound>();

  const spaces: SyncGraphSpace[] = [];
  const edges: SyncGraphEdge[] = [];

  // ① 历史里的空间（不含当前空间的 watermarks，下面单独并进来）
  for (const [name, lastRound] of rounds) {
    spaces.push({
      spaceIndex: spaces.length + 1,
      spaceName: name,
      lastRound,
      hasEdges: false,
    });
  }

  // ② 当前空间的边（只有它现在有 watermarks 读数）
  if (wm && Array.isArray(wm.peers)) {
    const spaceName = String(wm.spaceName ?? "");
    // 同名空间已在历史里 ⇒ 复用那一行（⛔ 不重复造第二行，否则 hasEdges 会挂错行）
    const existing = spaces.find((s) => s.spaceName === spaceName);
    const spaceIndex = existing ? existing.spaceIndex : spaces.length + 1;
    const localMaxSeq = num(wm.localMaxSeq);
    if (existing) {
      existing.hasEdges = wm.peers.length > 0;
    } else {
      spaces.push({
        spaceIndex,
        spaceName,
        lastRound: rounds.get(spaceName) ?? null,
        hasEdges: wm.peers.length > 0,
      });
    }
    wm.peers.forEach((p, i) => {
      const peerIndex = num(p.index) || i + 1;
      const cursor = num(p.cursor);
      const lag = Math.max(0, localMaxSeq - cursor);
      const online = p.online === true ? true : p.online === false ? false : null;
      const lastOkAgoMs =
        typeof p.lastOkAgoMs === "number" && Number.isFinite(p.lastOkAgoMs) ? p.lastOkAgoMs : null;
      const level: SyncGraphEdge["level"] =
        online === null ? "unknown" : online === false || lag > 0 ? "warn" : "ok";
      const reason =
        `已收 ${cursor} / 本机 ${localMaxSeq}` +
        (lag > 0 ? `（落后 ${lag}）` : "（已齐）") +
        `；在线=${online === null ? "未知" : online ? "是" : "否"}；最近成功：${agoText(lastOkAgoMs)}`;
      const next =
        level === "ok"
          ? "不用处理"
          : online === false
            ? "等它上线；它离线期间的变化会在重连后补拉"
            : online === null
              ? "等它上线后点「立即同步」；仍无记录就看它是否配对、是否同网段"
              : "点「立即同步」再试；仍落后就看同步历史里的失败原因";
      edges.push({
        key: `space-${spaceIndex}-peer-${peerIndex}`,
        spaceIndex,
        spaceName,
        peerIndex,
        cursor,
        localMaxSeq,
        lag,
        online,
        lastOkAgoMs,
        level,
        reason,
        next,
      });
    });
  }

  const counts = {
    spaces: spaces.length,
    edges: edges.length,
    ok: edges.filter((e) => e.level === "ok").length,
    warn: edges.filter((e) => e.level === "warn").length,
    unknown: edges.filter((e) => e.level === "unknown").length,
  };

  let headline: string;
  if (!wm && !historyRows) {
    headline = "读不到同步图（水位与历史都没有读数）—— 先开一次应用再看";
  } else if (edges.length === 0) {
    headline = "当前空间没有可列出的设备边（可能还没配对/没开局域网同步）";
  } else if (counts.warn > 0) {
    headline = `有 ${counts.warn} 条边需要注意${counts.unknown > 0 ? `，另有 ${counts.unknown} 条读不到` : ""}`;
  } else if (counts.unknown > 0) {
    headline = `有 ${counts.unknown} 条边读不到（还没有成功记录）`;
  } else {
    headline = "所有已配对的边都已拉齐";
  }

  return { spaces, edges, counts, headline, at };
}

/**
 * 同步图的**脱敏纯文本**（给复制/工单用）。
 *
 * ⛔ 不含：空间名、设备号、地址、公钥、页面内容。
 * ✅ 含：空间序号、对端序号、水位/落后、在线三态、最近成功、最近一轮结果与原因码。
 */
export function syncGraphText(g: SyncGraph): string {
  const lines: string[] = [
    "[sync-graph] 多设备同步图（只读；脱敏：不含空间名、设备号与地址）",
    `结论：${g.headline}`,
    `统计：空间 ${g.counts.spaces} · 边 ${g.counts.edges}（好 ${g.counts.ok} / 注意 ${g.counts.warn} / 读不到 ${g.counts.unknown}）`,
  ];
  for (const s of g.spaces) {
    lines.push(
      "",
      `空间[${s.spaceIndex}]` +
        (s.lastRound
          ? ` 最近一轮=${s.lastRound.ok ? "成功" : "失败"}（拉取 ${s.lastRound.pulled} / 推送 ${s.lastRound.pushed}）` +
            (s.lastRound.message ? `；原文：${s.lastRound.message.replace(/\*\*/g, "")}` : "")
          : " 最近一轮=无记录"),
    );
    const es = g.edges.filter((e) => e.spaceIndex === s.spaceIndex);
    if (es.length === 0) {
      lines.push("  （这个空间没有设备边读数）");
      continue;
    }
    for (const e of es) {
      lines.push(
        `  对端[${e.peerIndex}] 已收=${e.cursor} · 本机=${e.localMaxSeq} · 落后=${e.lag}` +
          ` · 在线=${e.online === null ? "未知" : e.online ? "是" : "否"}` +
          ` · 最近成功=${agoText(e.lastOkAgoMs)}`,
      );
    }
  }
  lines.push("", "（这份图只含读数与原因；不含空间名、设备号、网络地址或页面内容。）");
  return lines.join("\n");
}
