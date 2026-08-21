import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { tagColor } from "../lib/tagColor";
import { useEditorStore } from "../store/editor";
import { useNotes } from "../store/notes";
import type { GraphBlock, GraphData, GraphEdge } from "../types";

interface SimNode {
  id: string;
  label: string;
  kind: "page" | "block";
  pageId?: string;
  tags?: string[];
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
) {
  const nodeById = new Map(ns.map((n) => [n.id, n]));
  const cx = size.w / 2;
  const cy = size.h / 2;
  const damping = 0.9;

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
      const f = 5000 / d2;
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      if (dragId !== a.id) {
        a.vx += fx;
        a.vy += fy;
      }
      if (dragId !== b.id) {
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
    const ideal = e.kind === "belongs" ? 60 : 120;
    const f = 0.04 * (d - ideal);
    const fx = (dx / d) * f;
    const fy = (dy / d) * f;
    if (dragId !== a.id) {
      a.vx += fx;
      a.vy += fy;
    }
    if (dragId !== b.id) {
      b.vx -= fx;
      b.vy -= fy;
    }
  }

  for (const n of ns) {
    if (dragId === n.id) {
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

export function GraphView() {
  const { currentId, openPage } = useNotes();
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showBlocks, setShowBlocks] = useState(false);
  const [mode, setMode] = useState<"all" | "local">("all");
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [colorByTag, setColorByTag] = useState(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [nodes, setNodes] = useState<SimNode[]>([]);
  const [frame, setFrame] = useState(0);
  const [size, setSize] = useState({ w: 900, h: 640 });

  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const simRef = useRef<SimNode[]>([]);
  const edgesRef = useRef<GraphEdge[]>([]);
  const viewRef = useRef({ x: 0, y: 0, k: 1 });
  const dragRef = useRef<{ id: string; scx: number; scy: number; nx: number; ny: number } | null>(null);
  const panRef = useRef<{ sx: number; sy: number; vx: number; vy: number } | null>(null);
  const movedRef = useRef(false);

  // Measure container.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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

    if (tagFilter) {
      const tagged = new Set(
        graph.pages.filter((p) => p.tags.includes(tagFilter)).map((p) => p.id),
      );
      visiblePageIds = visiblePageIds
        ? new Set([...visiblePageIds].filter((id) => tagged.has(id)))
        : tagged;
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
  }, [graph, size, showBlocks, mode, currentId, tagFilter]);

  // Force-directed simulation loop.
  useEffect(() => {
    if (nodes.length === 0) return;
    let raf = 0;
    let running = true;
    let settled = 0;
    let iterations = 0;
    const loop = () => {
      if (!running) return;
      tick(simRef.current, edgesRef.current, size, dragRef.current?.id ?? null);
      settled = maxSpeed(simRef.current) < 0.05 ? settled + 1 : 0;
      iterations += 1;
      setFrame((f) => f + 1);
      if (settled < 30 && iterations < 2500 && simRef.current.length > 1) {
        raf = requestAnimationFrame(loop);
      }
    };
    raf = requestAnimationFrame(loop);
    return () => {
      running = false;
      cancelAnimationFrame(raf);
    };
  }, [nodes, size]);

  const displayNodes = simRef.current;
  const nodeMap = useMemo(
    () => new Map(displayNodes.map((n) => [n.id, n])),
    [frame, nodes],
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

  const allTags = useMemo(() => {
    if (!graph) return [];
    const s = new Set<string>();
    for (const p of graph.pages) for (const t of p.tags) s.add(t);
    return [...s].sort();
  }, [graph]);

  const beginNodeDrag = (id: string, e: React.PointerEvent) => {
    e.stopPropagation();
    const node = simRef.current.find((n) => n.id === id);
    if (!node) return;
    dragRef.current = { id, scx: e.clientX, scy: e.clientY, nx: node.x, ny: node.y };
    movedRef.current = false;
    svgRef.current?.setPointerCapture(e.pointerId);
  };

  const onSvgPointerDown = (e: React.PointerEvent) => {
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

  const resetView = () => {
    viewRef.current = { x: 0, y: 0, k: 1 };
    setFrame((f) => f + 1);
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
      <svg
        ref={svgRef}
        width={size.w}
        height={size.h}
        className="graph-svg"
        onPointerDown={onSvgPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <g transform={`translate(${viewRef.current.x}, ${viewRef.current.y}) scale(${viewRef.current.k})`}>
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
            const tagFill =
              colorByTag &&
              n.kind === "page" &&
              n.tags &&
              n.tags.length > 0 &&
              currentId !== n.id
                ? tagColor(n.tags[0]).solid
                : undefined;
            return (
              <g
                key={n.id}
                transform={`translate(${n.x}, ${n.y})`}
                className={`graph-node ${n.kind === "block" ? "graph-node-block" : ""} ${
                  currentId === n.id ? "graph-node-current" : ""
                } ${dimmed ? "graph-node-dim" : ""}`}
                onPointerDown={(e) => beginNodeDrag(n.id, e)}
                onClick={() => openNode(n)}
                onMouseEnter={() => setHoveredId(n.id)}
                onMouseLeave={() => setHoveredId((h) => (h === n.id ? null : h))}
              >
                <circle
                  r={nodeRadius(n)}
                  className="graph-node-circle"
                  style={tagFill ? { fill: tagFill } : undefined}
                />
                <text y={n.kind === "block" ? -8 : 4} className="graph-node-label">
                  {n.kind === "block" ? shortLabel(n.label) : n.label || "未命名"}
                </text>
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
          value={tagFilter ?? ""}
          onChange={(e) => setTagFilter(e.target.value || null)}
          title="按标签过滤"
        >
          <option value="">全部标签</option>
          {allTags.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <button
          className={colorByTag ? "graph-toggle-active" : ""}
          onClick={() => setColorByTag((v) => !v)}
          title="按标签着色"
        >
          🎨
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
