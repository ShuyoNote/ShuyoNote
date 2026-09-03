import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { tagColor } from "../lib/tagColor";
import { useEditorStore } from "../store/editor";
import { useNotes } from "../store/notes";
import type { GraphBlock, GraphData, GraphEdge, GraphProp } from "../types";

interface SimNode {
  id: string;
  label: string;
  kind: "page" | "block";
  pageId?: string;
  tags?: string[];
  props?: GraphProp[];
  x: number;
  y: number;
  vx: number;
  vy: number;
  degree: number;
}

const EDGE_COLORS: Record<string, string> = {
  page: "var(--text-faint)",
  link: "var(--accent)",
  embed: "#22c55e",
  belongs: "var(--text-faint)",
};

const IN_COLOR = "#3370ff";
const OUT_COLOR = "#f59e0b";
// 超过该节点数的图跳过 O(n^2) 力导向动画，改用静态环状布局（性能守卫）。
const MAX_FORCE = 250;

function maxSpeed(ns: SimNode[]): number {
  let m = 0;
  for (const n of ns) {
    m = Math.max(m, Math.abs(n.vx), Math.abs(n.vy));
  }
  return m;
}

function tick(
  ns: SimNode[],
  edges: GraphEdge[],
  size: { w: number; h: number },
  dragId: string | null,
  dimension: string,
  pinned: Set<string>,
) {
  const nodeById = new Map(ns.map((n) => [n.id, n]));
  const cx = size.w / 2;
  const cy = size.h / 2;
  const damping = 0.9;
  const isFree = (id: string) => dragId !== id && !pinned.has(id);

  for (let i = 0; i < ns.length; i++) {
    for (let j = i + 1; j < ns.length; j++) {
      const a = ns[i];
      const b = ns[j];
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 1) {
        d2 = 1;
        dx = 1;
        dy = 0;
      }
      const d = Math.sqrt(d2);
      const f = 9000 / d2;
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      if (isFree(a.id)) {
        a.vx += fx;
        a.vy += fy;
      }
      if (isFree(b.id)) {
        b.vx -= fx;
        b.vy -= fy;
      }
    }
  }

  for (const e of edges) {
    const a = nodeById.get(e.source);
    const b = nodeById.get(e.target);
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const ideal = e.kind === "belongs" ? 80 : 150;
    const f = 0.04 * (d - ideal);
    const fx = (dx / d) * f;
    const fy = (dy / d) * f;
    if (isFree(a.id)) {
      a.vx += fx;
      a.vy += fy;
    }
    if (isFree(b.id)) {
      b.vx -= fx;
      b.vy -= fy;
    }
  }

  // Clustering force (M21.2): pull each page node toward its same-group centroid
  // so pages sharing a tag/attr value naturally clump together.
  const groups = new Map<string, { x: number; y: number; count: number }>();
  for (const n of ns) {
    const k = nodeClusterKey(n, dimension);
    if (!k) continue;
    const g = groups.get(k) ?? { x: 0, y: 0, count: 0 };
    g.x += n.x;
    g.y += n.y;
    g.count++;
    groups.set(k, g);
  }
  for (const n of ns) {
    if (!isFree(n.id)) continue;
    const k = nodeClusterKey(n, dimension);
    if (!k) continue;
    const g = groups.get(k)!;
    if (g.count < 2) continue;
    const gx = g.x / g.count;
    const gy = g.y / g.count;
    n.vx += (gx - n.x) * 0.02;
    n.vy += (gy - n.y) * 0.02;
  }

  for (const n of ns) {
    if (!isFree(n.id)) {
      n.vx = 0;
      n.vy = 0;
      continue;
    }
    n.vx += (cx - n.x) * 0.001;
    n.vy += (cy - n.y) * 0.001;
    n.vx *= damping;
    n.vy *= damping;
    n.x += n.vx;
    n.y += n.vy;
    n.x = Math.max(20, Math.min(size.w - 20, n.x));
    n.y = Math.max(20, Math.min(size.h - 20, n.y));
  }
}

function nodeRadius(n: SimNode): number {
  if (n.kind === "block") return 5;
  return Math.max(6, Math.min(6 + n.degree * 2, 22));
}

function shortLabel(label: string, max = 14): string {
  const s = label.trim();
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

// Values of a page for the current grouping dimension ("tag" or "attr:<name>").
function pageDimValues(
  p: { tags?: string[]; props?: GraphProp[] },
  dimension: string,
): string[] {
  if (dimension === "tag") return p.tags ?? [];
  const name = dimension.startsWith("attr:") ? dimension.slice(5) : "";
  return (p.props ?? []).filter((pr) => pr.name === name).map((pr) => pr.value);
}

// The cluster key for a node in the current grouping dimension ("tag" | "attr:<name>").
// Page nodes group by their first value; block nodes never cluster. Returns null
// when the node has no grouping value (it then drifts freely, no cluster pull).
function nodeClusterKey(n: SimNode, dimension: string): string | null {
  if (n.kind !== "page") return null;
  const vals = pageDimValues(n, dimension);
  return vals.length > 0 ? `${dimension}:${vals[0]}` : null;
}

export function GraphView() {
  const { currentId, openPage } = useNotes();
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showBlocks, setShowBlocks] = useState(false);
  const [mode, setMode] = useState<"all" | "local">("all");
  const [dimension, setDimension] = useState("tag"); // "tag" | "attr:<name>"
  const [valueFilter, setValueFilter] = useState<string | null>(null);
  const [colorBy, setColorBy] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set());
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [nodes, setNodes] = useState<SimNode[]>([]);
  const [frame, setFrame] = useState(0);
  const [size, setSize] = useState({ w: 900, h: 640 });

  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const simRef = useRef<SimNode[]>([]);
  const edgesRef = useRef<GraphEdge[]>([]);
  const viewRef = useRef({ x: 0, y: 0, k: 1 });
  const userMovedRef = useRef(false);
  const dragRef = useRef<{ id: string; scx: number; scy: number; nx: number; ny: number } | null>(null);
  const panRef = useRef<{ sx: number; sy: number; vx: number; vy: number } | null>(null);
  const movedRef = useRef(false);
  const pinnedIdsRef = useRef<Set<string>>(new Set());
  pinnedIdsRef.current = pinnedIds;

  // Measure container.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const fit = () => {
      const rect = el.getBoundingClientRect();
      const w = rect.width, h = rect.height;
      if (w <= 0 || h <= 0) return;
      if (userMovedRef.current) return;
      const k = 1.2;
      const x = w / 2 - (w / 2) * k;
      const y = h / 2 - (h / 2) * k;
      viewRef.current = { x, y, k };
      setSize({ w, h });
      setFrame((f) => f + 1);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [graph]);

  // Load graph data.
  useEffect(() => {
    api
      .getGraph()
      .then(setGraph)
      .catch((e) => setError(String(e)));
  }, []);

  // Wheel zoom (native listener so we can preventDefault on passive:false).
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      userMovedRef.current = true;
      const rect = svg.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const v = viewRef.current;
      const k2 = Math.min(3, Math.max(0.2, v.k * (e.deltaY < 0 ? 1.1 : 0.9)));
      const wx = (mx - v.x) / v.k;
      const wy = (my - v.y) / v.k;
      v.x = mx - wx * k2;
      v.y = my - wy * k2;
      v.k = k2;
      setFrame((f) => f + 1);
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, []);

  // Build nodes + edges (filtered by mode / block-layer toggle).
  useEffect(() => {
    if (!graph) return;
    const allPageEdges = graph.edges.filter((e) => e.source !== e.target);

    // Determine visible page ids (null = all), composing local-graph + tag filter.
    let visiblePageIds: Set<string> | null = null;

    const localFocus = mode === "local" ? currentId : null;
    if (localFocus && graph.pages.some((p) => p.id === localFocus)) {
      const s = new Set<string>([localFocus]);
      for (const e of allPageEdges) {
        if (e.source === localFocus) s.add(e.target);
        else if (e.target === localFocus) s.add(e.source);
      }
      visiblePageIds = s;
    }

    if (valueFilter) {
      const matching = new Set(
        graph.pages.filter((p) => pageDimValues(p, dimension).includes(valueFilter)).map((p) => p.id),
      );
      visiblePageIds = visiblePageIds
        ? new Set([...visiblePageIds].filter((id) => matching.has(id)))
        : matching;
    }

    const pageNodes = visiblePageIds
      ? graph.pages.filter((p) => visiblePageIds!.has(p.id))
      : graph.pages;
    const pageEdges = allPageEdges.filter((e) =>
      visiblePageIds
        ? visiblePageIds.has(e.source) && visiblePageIds.has(e.target)
        : true,
    );

    let blockNodes: GraphBlock[] = showBlocks ? graph.blocks : [];
    let blockEdges: GraphEdge[] = showBlocks ? graph.block_edges : [];
    if (showBlocks && visiblePageIds) {
      blockNodes = blockNodes.filter((b) => visiblePageIds!.has(b.page_id));
      const visibleIds = new Set<string>([
        ...visiblePageIds,
        ...blockNodes.map((b) => b.id),
      ]);
      blockEdges = blockEdges.filter(
        (e) => visibleIds.has(e.source) && visibleIds.has(e.target),
      );
    }

    const edges = [...pageEdges, ...blockEdges];
    edgesRef.current = edges;

    const degree = new Map<string, number>();
    const pageSimNodes: SimNode[] = pageNodes.map((p) => {
      degree.set(p.id, 0);
      return {
        id: p.id,
        label: p.title,
        kind: "page" as const,
        tags: p.tags,
        props: p.props,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        degree: 0,
      };
    });
    const blockSimNodes: SimNode[] = blockNodes.map((b) => {
      degree.set(b.id, 0);
      return {
        id: b.id,
        label: b.label,
        kind: "block" as const,
        pageId: b.page_id,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        degree: 0,
      };
    });
    const allNodes = [...pageSimNodes, ...blockSimNodes];

    for (const e of edges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }

    const cx = size.w / 2;
    const cy = size.h / 2;
    const r = Math.min(size.w, size.h) * 0.3;
    const count = Math.max(allNodes.length, 1);
    allNodes.forEach((n, i) => {
      n.degree = degree.get(n.id) ?? 0;
      const angle = (i / count) * Math.PI * 2;
      n.x = cx + Math.cos(angle) * r + (Math.random() - 0.5) * 20;
      n.y = cy + Math.sin(angle) * r + (Math.random() - 0.5) * 20;
    });

    simRef.current = allNodes;
    setNodes(allNodes);
  }, [graph, size, showBlocks, mode, currentId, dimension, valueFilter]);

  // Force-directed simulation loop.
  useEffect(() => {
    if (nodes.length === 0) return;
    // 大规模图：静态环状布局（simRef 已是环状初始），不跑 O(n^2) 力导向动画。
    if (nodes.length > MAX_FORCE) {
      setFrame((f) => f + 1);
      return;
    }
    let raf = 0;
    let running = true;
    let settled = 0;
    let iterations = 0;
    let frameTick = 0;
    const loop = () => {
      if (!running) return;
      tick(simRef.current, edgesRef.current, size, dragRef.current?.id ?? null, dimension, pinnedIdsRef.current);
      // 更严格收敛判定：避免初始环状速度就被判“已稳定”而几乎不动(显得卡住)。
      settled = maxSpeed(simRef.current) < 0.03 ? settled + 1 : 0;
      iterations += 1;
      // 节流：每 2 帧才触发一次 React 渲染(~30fps)，减轻大量节点/边的渲染负担。
      if (frameTick++ % 2 === 0) setFrame((f) => f + 1);
      if (settled < 30 && iterations < 500 && simRef.current.length > 1) {
        raf = requestAnimationFrame(loop);
      }
    };
    raf = requestAnimationFrame(loop);
    return () => {
      running = false;
      cancelAnimationFrame(raf);
    };
  }, [nodes, size, dimension]);

  const displayNodes = simRef.current;
  const nodeMap = useMemo(
    () => new Map(displayNodes.map((n) => [n.id, n])),
    // 节点集合变化时才重建；拖动/缩放/力导向只改对象的 x/y，不重建映射。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodes],
  );

  // Focus = hovered node, or the current page in local-graph mode.
  const focusId = hoveredId ?? (mode === "local" ? currentId : null);
  const neighborSet = new Set<string>();
  if (focusId) {
    neighborSet.add(focusId);
    for (const e of edgesRef.current) {
      if (e.source === focusId) neighborSet.add(e.target);
      else if (e.target === focusId) neighborSet.add(e.source);
    }
  }

  // Keyword highlight (M21.2): nodes whose label contains the term get a
  // highlight ring; matching set also drives the highlight of non-matches.
  const kw = keyword.trim().toLowerCase();
  const nodeLabel = (n: SimNode) => (n.label || "未命名").toLowerCase().includes(kw);
  const kwActive = kw.length > 0;

  const togglePin = (id: string) => {
    const next = new Set(pinnedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPinnedIds(next);
  };
  const pinFocus = () => {
    const id = hoveredId ?? focusId;
    if (id) togglePin(id);
  };

  // Select-attribute names (grouping dimensions) + values of the current dimension.
  const dimensionNames = useMemo(() => {
    if (!graph) return [];
    const s = new Set<string>();
    for (const p of graph.pages) for (const pr of p.props) s.add(pr.name);
    return [...s].sort();
  }, [graph]);

  const dimensionValues = useMemo(() => {
    if (!graph) return [];
    const s = new Set<string>();
    for (const p of graph.pages) for (const v of pageDimValues(p, dimension)) s.add(v);
    return [...s].sort();
  }, [graph, dimension]);

  const beginNodeDrag = (id: string, e: React.PointerEvent) => {
    e.stopPropagation();
    userMovedRef.current = true;
    const node = simRef.current.find((n) => n.id === id);
    if (!node) return;
    dragRef.current = { id, scx: e.clientX, scy: e.clientY, nx: node.x, ny: node.y };
    movedRef.current = false;
    svgRef.current?.setPointerCapture(e.pointerId);
  };

  const onSvgPointerDown = (e: React.PointerEvent) => {
    userMovedRef.current = true;
    panRef.current = { sx: e.clientX, sy: e.clientY, vx: viewRef.current.x, vy: viewRef.current.y };
    movedRef.current = false;
    svgRef.current?.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (dragRef.current) {
      const d = dragRef.current;
      const node = simRef.current.find((n) => n.id === d.id);
      if (node) {
        if (Math.abs(e.clientX - d.scx) + Math.abs(e.clientY - d.scy) > 3) movedRef.current = true;
        const k = viewRef.current.k;
        node.x = d.nx + (e.clientX - d.scx) / k;
        node.y = d.ny + (e.clientY - d.scy) / k;
        node.vx = 0;
        node.vy = 0;
        setFrame((f) => f + 1);
      }
      return;
    }
    if (panRef.current) {
      const p = panRef.current;
      viewRef.current.x = p.vx + (e.clientX - p.sx);
      viewRef.current.y = p.vy + (e.clientY - p.sy);
      setFrame((f) => f + 1);
    }
  };

  const onPointerUp = () => {
    dragRef.current = null;
    panRef.current = null;
  };

  const zoomBy = (factor: number) => {
    userMovedRef.current = true;
    const v = viewRef.current;
    const k2 = Math.min(3, Math.max(0.2, v.k * factor));
    const cx = size.w / 2;
    const cy = size.h / 2;
    const wx = (cx - v.x) / v.k;
    const wy = (cy - v.y) / v.k;
    v.x = cx - wx * k2;
    v.y = cy - wy * k2;
    v.k = k2;
    setFrame((f) => f + 1);
  };

  // Fit the graph into the container, zoomed one step: content centre is aligned
  // to the container centre so the graph appears centred (not stuck top-left),
  // and scaled up a notch (k=1.2) for a comfortable initial view.
  const fitToView = (k = 1.2) => {
    const { w, h } = size;
    // Content (world) centre is at (w/2, h/2); after translate(x,y) scale(k) that
    // world point lands at (w/2*k + x, h/2*k + y). Set x/y so it sits at (w/2,h/2).
    const x = w / 2 - (w / 2) * k;
    const y = h / 2 - (h / 2) * k;
    viewRef.current = { x, y, k };
    setFrame((f) => f + 1);
  };

  const resetView = () => {
    userMovedRef.current = false;
    fitToView(1.2);
  };

  const openNode = (n: SimNode) => {
    if (movedRef.current) return;
    if (n.kind === "block") {
      useEditorStore.getState().setFocusBlockId(n.id);
      if (n.pageId && n.pageId !== currentId) openPage(n.pageId);
    } else {
      openPage(n.id);
    }
  };

  if (error) {
    return <div className="graph-view graph-view-empty">加载关系图失败：{error}</div>;
  }
  if (!graph) {
    return <div className="graph-view graph-view-empty">加载关系图…</div>;
  }
  if (graph.pages.length === 0) {
    return <div className="graph-view graph-view-empty">暂无页面，先新建几个页面吧</div>;
  }

  return (
    <div className="graph-view" ref={containerRef}>
      {nodes.length > MAX_FORCE && (
        <div className="graph-hint">
          图较大（{nodes.length} 个节点），已用环状布局以保流畅；可用上方筛选 / 局部模式缩小范围后获得力导向布局。
        </div>
      )}
      <svg
        ref={svgRef}
        width="100%"
        height="100%"
        className="graph-svg"
        onPointerDown={onSvgPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <g data-frame={frame} transform={`translate(${viewRef.current.x}, ${viewRef.current.y}) scale(${viewRef.current.k})`}>
          {edgesRef.current.map((e, i) => {
            const a = nodeMap.get(e.source);
            const b = nodeMap.get(e.target);
            if (!a || !b) return null;
            const touching = focusId && (e.source === focusId || e.target === focusId);
            const dimmed = focusId && !touching;
            let stroke = EDGE_COLORS[e.kind] ?? "var(--text-faint)";
            let cls = `graph-edge graph-edge-${e.kind}`;
            if (focusId && touching) {
              stroke = e.source === focusId ? OUT_COLOR : IN_COLOR;
              cls += " graph-edge-active";
            } else if (dimmed) {
              cls += " graph-edge-dim";
            }
            return (
              <line
                key={`${e.source}-${e.target}-${i}`}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                className={cls}
                stroke={stroke}
              />
            );
          })}
          {displayNodes.map((n) => {
            const dimmed = focusId && !neighborSet.has(n.id);
            const isPinned = pinnedIds.has(n.id);
            const isMatch = kwActive && nodeLabel(n);
            const isDimByKw = kwActive && !isMatch;
            const dimValues =
              colorBy && n.kind === "page" && currentId !== n.id
                ? pageDimValues(n, dimension)
                : [];
            const tagFill = dimValues.length > 0 ? tagColor(dimValues[0]).solid : undefined;
            return (
              <g
                key={n.id}
                transform={`translate(${n.x}, ${n.y})`}
                className={`graph-node ${n.kind === "block" ? "graph-node-block" : ""} ${
                  currentId === n.id ? "graph-node-current" : ""
                } ${dimmed ? "graph-node-dim" : ""} ${isPinned ? "graph-node-pinned" : ""} ${
                  isMatch ? "graph-node-match" : ""
                } ${isDimByKw ? "graph-node-dim" : ""}`}
                onPointerDown={(e) => beginNodeDrag(n.id, e)}
                onClick={() => openNode(n)}
                onMouseEnter={() => setHoveredId(n.id)}
                onMouseLeave={() => setHoveredId((h) => (h === n.id ? null : h))}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  togglePin(n.id);
                }}
              >
                <circle
                  r={nodeRadius(n)}
                  className="graph-node-circle"
                  style={tagFill ? { fill: tagFill } : undefined}
                />
                <text y={n.kind === "block" ? -8 : 4} className="graph-node-label">
                  {n.kind === "block" ? shortLabel(n.label) : n.label || "未命名"}
                </text>
                {isPinned ? (
                  <text x={nodeRadius(n) + 2} y={-6} className="graph-node-pin">
                    📌
                  </text>
                ) : null}
                <title>{n.kind === "block" ? n.label || "(空块)" : n.label || "未命名"}</title>
              </g>
            );
          })}
        </g>
      </svg>

      <div className="graph-controls">
        <button onClick={() => zoomBy(1.25)} title="放大">+</button>
        <button onClick={() => zoomBy(0.8)} title="缩小">−</button>
        <button onClick={resetView} title="复位视图">⤢</button>
        <span className="graph-controls-sep" />
        <button
          className={mode === "all" ? "graph-toggle-active" : ""}
          onClick={() => setMode("all")}
        >
          全部
        </button>
        <button
          className={mode === "local" ? "graph-toggle-active" : ""}
          onClick={() => setMode("local")}
          disabled={!currentId}
        >
          局部
        </button>
        <span className="graph-controls-sep" />
        <select
          className="graph-select"
          value={dimension}
          onChange={(e) => {
            setDimension(e.target.value);
            setValueFilter(null);
          }}
          title="分组维度"
        >
          <option value="tag">标签</option>
          {dimensionNames.map((name) => (
            <option key={name} value={`attr:${name}`}>
              {name}
            </option>
          ))}
        </select>
        <select
          className="graph-select"
          value={valueFilter ?? ""}
          onChange={(e) => setValueFilter(e.target.value || null)}
          title="按值过滤"
        >
          <option value="">全部</option>
          {dimensionValues.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
        <button
          className={colorBy ? "graph-toggle-active" : ""}
          onClick={() => setColorBy((v) => !v)}
          title="按维度着色"
        >
          🎨
        </button>
        <span className="graph-controls-sep" />
        <input
          className="graph-search"
          type="text"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="高亮关键词…"
          title="按关键词高亮节点"
        />
        <button
          className={pinnedIds.size > 0 ? "graph-toggle-active" : ""}
          onClick={pinFocus}
          disabled={!(hoveredId ?? focusId)}
          title="锁定/解锁悬停节点（双击节点亦可）"
        >
          📌
        </button>
      </div>

      <div className="graph-legend">
        <span className="graph-legend-item">
          <i style={{ background: EDGE_COLORS.page }} /> 页面引用
        </span>
        <span className="graph-legend-item">
          <i style={{ background: EDGE_COLORS.link }} /> 块引用
        </span>
        <span className="graph-legend-item">
          <i style={{ background: EDGE_COLORS.embed }} /> 块嵌入
        </span>
        <span className="graph-legend-item">
          <i style={{ background: OUT_COLOR }} /> 出链
        </span>
        <span className="graph-legend-item">
          <i style={{ background: IN_COLOR }} /> 入链
        </span>
        <button
          className={`graph-toggle ${showBlocks ? "graph-toggle-active" : ""}`}
          onClick={() => setShowBlocks((v) => !v)}
        >
          块级{graph.blocks.length > 0 ? ` (${graph.blocks.length})` : ""}
        </button>
      </div>
    </div>
  );
}
