// S4 知识地图 · 数据层的判据（纯函数 ✓，不需要浏览器、不需要库）。
//
// 判据 `scripts/check-kb-s4-map.mjs` 只能核"声明在不在、成不成对、引没引既有出处"；
// 这三条的**行为**（上限真的生效／截断真的说出来／聚类与边真的收得住）只有跑起来才知道 ✓。
import { describe, expect, it } from "vitest";

import type { GraphData, GraphEdge, GraphPage } from "../types";
import { GRAPH_NODE_CAP, GRAPH_TRUNCATED, UNTAGGED, buildKbMap } from "./kbMap";

const page = (id: string, title: string, tags: string[] = []): GraphPage => ({ id, title, tags, props: [] });
const edge = (source: string, target: string, kind = "page"): GraphEdge => ({ source, target, kind });
const graph = (pages: GraphPage[], edges: GraphEdge[] = []): GraphData => ({ pages, edges, blocks: [], block_edges: [], blocks_supported: true });

describe("S4 · 上限与「只画了一部分」", () => {
  it("没超上限 ⇒ truncated=false、hidden=0（不许永远说截断了 ✗）", () => {
    const m = buildKbMap(graph([page("a", "甲"), page("b", "乙")]));
    expect(m.pages).toHaveLength(2);
    expect(m[GRAPH_TRUNCATED]).toBe(false);
    expect(m.hidden).toBe(0);
  });

  it("超上限 ⇒ 只画 cap 个、truncated=true、且 hidden 说得清少了几个", () => {
    const pages = Array.from({ length: 12 }, (_, i) => page(`p${i}`, `页${i}`));
    const m = buildKbMap(graph(pages), 5);
    expect(m.pages).toHaveLength(5);
    expect(m[GRAPH_TRUNCATED]).toBe(true);
    expect(m.hidden).toBe(7);
  });

  it("默认上限就是 GRAPH_NODE_CAP（判据要求它是个**数** ✓）", () => {
    expect(Number.isInteger(GRAPH_NODE_CAP)).toBe(true);
    expect(GRAPH_NODE_CAP).toBeGreaterThan(0);
    const pages = Array.from({ length: GRAPH_NODE_CAP + 3 }, (_, i) => page(`q${i}`, `页${i}`));
    const m = buildKbMap(graph(pages));
    expect(m.pages).toHaveLength(GRAPH_NODE_CAP);
    expect(m.hidden).toBe(3);
  });

  it("空图／还没读到 ⇒ 空结果，不抛", () => {
    expect(buildKbMap(null).pages).toEqual([]);
    expect(buildKbMap(null)[GRAPH_TRUNCATED]).toBe(false);
    expect(buildKbMap(graph([])).clusters).toEqual([]);
  });
});

describe("S4 · 先画谁（确定性）与边的收口", () => {
  it("度数高的先画；度数相同按标题、再按 id（顺序稳定 ⇒ 可复现）", () => {
    // ⚠️ 标题用 **ASCII**：排序是**码位序**（`<`）而不是字典序 —— 用中文写会让人误判
    //    （实测：`丙`(U+4E19) < `甲`(U+7532) ⇒ 中文例子里"直觉顺序"与实际顺序相反 ✗）。
    const pages = [page("a", "B"), page("b", "A"), page("c", "C")];
    const edges = [edge("a", "b"), edge("a", "c")]; // a 的度数 2，b/c 各 1
    const m = buildKbMap(graph(pages, edges), 2);
    expect(m.pages.map((p) => p.id)).toEqual(["a", "b"]); // a 度数最高；b 与 c 同度 ⇒ 标题 "A" 在前 ✓
  });

  it("只留**两端都画出来**的边（免得出现指向没画出来的节点的悬空线 ✗）", () => {
    const pages = [page("a", "A"), page("b", "B"), page("c", "C")];
    const edges = [edge("a", "b"), edge("b", "c")];
    const m = buildKbMap(graph(pages, edges), 2); // 画出**度数最高的 b**（2 度）＋ a（1 度、标题最靠前）✓
    expect(m.pages.map((p) => p.id)).toEqual(["b", "a"]);
    expect(m.edges).toEqual([edge("a", "b")]); // b–c 那条被丢了：c 没画出来 ✓
  });
});

describe("S4 · 聚类（只按既有数据，不自己算关系）", () => {
  it("按**第一个标签**聚类；没有标签的进 UNTAGGED（不装成某个标签 ✗）", () => {
    const pages = [page("a", "A", ["research"]), page("b", "B", ["research", "old"]), page("c", "C")];
    const m = buildKbMap(graph(pages));
    const keys = m.clusters.map((c) => c.key);
    expect(keys).toEqual(["research", UNTAGGED]); // 数量降序：research 2 个 ✓
    expect(m.clusters[0].pages.map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("聚类数量相同 ⇒ 按键稳定排序（可复现）", () => {
    const m = buildKbMap(graph([page("a", "A", ["beta"]), page("b", "B", ["alpha"])]));
    expect(m.clusters.map((c) => c.key)).toEqual(["alpha", "beta"]);
  });
});
