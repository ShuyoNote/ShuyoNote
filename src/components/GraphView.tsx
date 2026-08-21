import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { useEditorStore } from "../store/editor";
import { useNotes } from "../store/notes";
import type { GraphData, GraphEdge } from "../types";

interface SimNode {
  id: string;
  label: string;
  kind: "page" | "block";
  pageId?: string;
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
  const [nodes, setNodes] = useState<SimNode[]>([]);
  const [frame, setFrame] = useState(0);
  const [size, setSize] = useState({ w: 900, h: 640 });

  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const simRef = useRef<SimNode[]>([]);
  const edgesRef = useRef<GraphEdge[]>([]);
  const dragRef = useRef<{ id: string; dx: number; dy: number } | null>(null);
  const movedRef = useRef(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    api
      .getGraph()
      .then(setGraph)
      .catch((e) => setError(String(e)));
  }, []);

  // Build nodes + edges whenever graph / size / block-layer toggle changes.
  useEffect(() => {
    if (!graph) return;
    const pageEdges = graph.edges.filter((e) => e.source !== e.target);
    const blockEdges = showBlocks ? graph.block_edges : [];
    const edges = [...pageEdges, ...blockEdges];
    edgesRef.current = edges;

    const degree = new Map<string, number>();
    const pageNodes: SimNode[] = graph.pages.map((p) => {
      degree.set(p.id, 0);
      return {
        id: p.id,
        label: p.title,
        kind: "page" as const,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        degree: 0,
      };
    });
    const blockNodes: SimNode[] = showBlocks
      ? graph.blocks.map((b) => {
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
        })
      : [];
    const allNodes = [...pageNodes, ...blockNodes];

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
  }, [graph, size, showBlocks]);

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

  const beginDrag = (id: string, e: React.PointerEvent) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const node = simRef.current.find((n) => n.id === id);
    if (!node) return;
    dragRef.current = {
      id,
      dx: e.clientX - rect.left - node.x,
      dy: e.clientY - rect.top - node.y,
    };
    movedRef.current = false;
    svg.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const node = simRef.current.find((n) => n.id === drag.id);
    if (!node) return;
    const x = e.clientX - rect.left - drag.dx;
    const y = e.clientY - rect.top - drag.dy;
    if (Math.abs(x - node.x) + Math.abs(y - node.y) > 3) movedRef.current = true;
    node.x = x;
    node.y = y;
    node.vx = 0;
    node.vy = 0;
    setFrame((f) => f + 1);
  };

  const onPointerUp = () => {
    dragRef.current = null;
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
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {edgesRef.current.map((e, i) => {
          const a = nodeMap.get(e.source);
          const b = nodeMap.get(e.target);
          if (!a || !b) return null;
          return (
            <line
              key={`${e.source}-${e.target}-${i}`}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              className={`graph-edge graph-edge-${e.kind}`}
              stroke={EDGE_COLORS[e.kind] ?? "var(--text-faint)"}
            />
          );
        })}
        {displayNodes.map((n) => (
          <g
            key={n.id}
            transform={`translate(${n.x}, ${n.y})`}
            className={`graph-node ${n.kind === "block" ? "graph-node-block" : ""} ${
              currentId === n.id ? "graph-node-current" : ""
            }`}
            onPointerDown={(e) => beginDrag(n.id, e)}
            onClick={() => openNode(n)}
          >
            <circle r={nodeRadius(n)} className="graph-node-circle" />
            <text y={n.kind === "block" ? -8 : 4} className="graph-node-label">
              {n.kind === "block" ? shortLabel(n.label) : n.label || "未命名"}
            </text>
            <title>
              {n.kind === "block" ? `${n.label || "(空块)"}` : n.label || "未命名"}
            </title>
          </g>
        ))}
      </svg>
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
