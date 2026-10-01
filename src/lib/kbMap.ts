// KB-S4-MAP —— S4「知识地图」的数据层（**只读** ✓；关系**可从内容重建** ✓）。
//
// 判据：`scripts/check-kb-s4-map.mjs` 的三条（R105=A 采用的 S4 出口判据 ✓）：
//   ① **关系可重建**：本文件只从 `get_graph` 那一份既有数据算聚类与度数 ⇒ 不落库、不另存一份 ✓
//      （`INV-KB-derived-rebuildable` ✓）；
//   ② **大库不许拖死界面**：`GRAPH_NODE_CAP`（**带数字** ✓）＋ 结果里那个"只画了一部分"的标志
//      `GRAPH_TRUNCATED` ✓ —— 两者**成对** ⇒ 不存在「悄悄截断」✗（本仓逐字罚过那一族 ✓）；
//   ③ **口径复用**：关系数据一律来自 `get_graph`（`GraphView` 用的**同一条** ✓）⇒ 不自己写 `[[` 匹配 ✗。
import type { GraphData, GraphEdge, GraphPage } from "../types";

/** 一次最多画多少个节点 ✓（大库不许拖死界面 ✓）。 */
export const GRAPH_NODE_CAP = 500;

/**
 * 结果里那个「只画了一部分」的标志位**名字** ✓（判据认这个名字、界面也读它 ✓）。
 *
 * ⚠️ 它是**名字**而不是 `true`：截断与否得由这次的数据定（写死成常量就等于永远说"截断了" ✗）。
 */
export const GRAPH_TRUNCATED = "truncated" as const;

/** 没有标签的页面归到这里 ✓（不装成某个标签 ✓）。 */
export const UNTAGGED = "untagged";

export interface KbMapCluster {
  /** 聚类的键（标签名，或 `UNTAGGED` ✓） */
  key: string;
  /** 给人看的名字 ✓（界面负责把 `UNTAGGED` 翻成「未分类」✓） */
  label: string;
  pages: GraphPage[];
}

export interface KbMap {
  /** 按标签聚的类（数量多的在前 ✓） */
  clusters: KbMapCluster[];
  /** 这次真的画出来的页面 ✓（受 `GRAPH_NODE_CAP` 约束 ✓） */
  pages: GraphPage[];
  /** 只保留**两端都画出来**的边 ✓（免得出现指向没画出来的节点的悬空线 ✗） */
  edges: GraphEdge[];
  /** ⚠️ **只画了一部分** ✓（`true` 时界面必须说出来 ✓） */
  [GRAPH_TRUNCATED]: boolean;
  /** 被上限挡掉的页面数 ✓（界面要能说"少画了几个" ✓） */
  hidden: number;
}

/** 页面级度数（只为"先画谁"服务 ✓；同一份关系算一遍，不落库 ✓）。 */
function degreeOf(edges: readonly GraphEdge[]): Map<string, number> {
  const deg = new Map<string, number>();
  for (const e of edges) {
    deg.set(e.source, (deg.get(e.source) ?? 0) + 1);
    deg.set(e.target, (deg.get(e.target) ?? 0) + 1);
  }
  return deg;
}

/**
 * 由 `get_graph` 的数据建一张**知识地图** ✓。
 *
 * 确定性（可测、可复现 ✓）：先按度数降序，再按标题、再按 id —— 三者都一样时顺序稳定 ✓。
 * ⚠️ 字符串比较是**码位序**（JS 的 `<`），**不是**字典序 ✓ —— 换个语言/区域也不变 ⇒ 同一份数据在哪台机器上
 * 画出来的顺序都一样 ✓（代价：中文标题的"顺序"看起来不是拼音序 —— 这一层不负责给人排字典序 ✓，
 * 界面要好看得由调用方再排，而不是让这一层**随 locale 变** ✗）。
 * `graph` 为 `null`（还没读到）⇒ 空图 ✓。
 */
export function buildKbMap(graph: GraphData | null | undefined, cap: number = GRAPH_NODE_CAP): KbMap {
  const all = graph?.pages ?? [];
  const edges = graph?.edges ?? [];
  const deg = degreeOf(edges);
  const ordered = [...all].sort((a, b) => {
    const da = deg.get(a.id) ?? 0;
    const db = deg.get(b.id) ?? 0;
    if (da !== db) return db - da;
    if (a.title !== b.title) return a.title < b.title ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const limit = Math.max(0, Math.floor(cap));
  const pages = ordered.slice(0, limit);
  const kept = new Set(pages.map((p) => p.id));
  const hidden = Math.max(0, all.length - pages.length);

  // 聚类：按**第一个标签**（没有标签的进 UNTAGGED ✓）；类内顺序沿用 pages 的顺序 ✓
  const byKey = new Map<string, GraphPage[]>();
  for (const p of pages) {
    const key = p.tags.length > 0 ? p.tags[0] : UNTAGGED;
    const list = byKey.get(key);
    if (list) list.push(p);
    else byKey.set(key, [p]);
  }
  const clusters: KbMapCluster[] = [...byKey.entries()]
    .map(([key, ps]) => ({ key, label: key, pages: ps }))
    .sort((a, b) => (a.pages.length !== b.pages.length ? b.pages.length - a.pages.length : a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  return {
    clusters,
    pages,
    edges: edges.filter((e) => kept.has(e.source) && kept.has(e.target)),
    [GRAPH_TRUNCATED]: hidden > 0,
    hidden,
  };
}
