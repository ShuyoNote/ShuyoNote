import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { tagColor } from "../lib/tagColor";
import { useEditorStore } from "../store/editor";
import { useNotes } from "../store/notes";
import { useSpaceStore } from "../store/space";
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

// 布局的力与收敛逻辑抽到 `src/lib/graphLayout.ts`（纯函数、带机器判据）—— 见那个文件的注释：
// 上一版（无退火 + `maxSpeed<0.03` 判据）实测**永远不收敛**，每次都跑满 500 帧（60fps 下 8.3 秒）
// 然后冻在抖动状态里；现在靠"退火 + 单帧位移上限 + 按位移判稳"，250 节点 90–110 帧就停。
import {
  DEFAULT_ANNEAL,
  MIN_ALPHA,
  settle,
  tick,
  type LayoutOptions,
} from "../lib/graphLayout";
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
  const spaceId = useSpaceStore((s) => s.activeId);
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
  // 拖拽唤醒计数：变了就再跑一段局部松弛（见下面那个 effect）。
  const [wake, setWake] = useState(0);
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
  const lastClickRef = useRef<{ id: string; t: number }>({ id: "", t: 0 });
  const pointerDownRef = useRef<{ id: string; t: number } | null>(null);
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
  }, [spaceId]);

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

  // 布局：**图一变就同步预热到稳**（首帧就是稳的，不用等几秒），只有预算用完（大图）才交给 rAF。
  //
  // 为什么不再"每帧 tick + maxSpeed 判据"：那条判据实测永远达不到 ⇒ 每次都跑满 500 帧
  // （60fps 下 8.3 秒，120Hz 屏 4.2 秒）然后冻在抖动里。现在：退火 + 单帧位移上限 + 按位移判稳。
  useEffect(() => {
    if (nodes.length === 0) return;
    // 大规模图：静态环状布局（simRef 已是环状初始），不跑 O(n^2) 力导向。
    if (nodes.length > MAX_FORCE) {
      setFrame((f) => f + 1);
      return;
    }
    const opts: LayoutOptions = {
      clusterKey: (n) => nodeClusterKey(n as SimNode, dimension),
      pinned: pinnedIdsRef.current,
    };
    // 预热预算 60ms：250 节点实测整段收敛只要 ~90ms 里的一小部分（纯计算 ~70ms），
    // 超过预算就让下面那段 rAF 接着跑（仍会退火停住，不会再"抖很久"）。
    const pre = settle(simRef.current, edgesRef.current, size, { ...opts, budgetMs: 60 });
    setFrame((f) => f + 1);
    if (pre.stable) return; // 已经稳了：**不挂 rAF**，不再每帧重渲染

    let raf = 0;
    let running = true;
    let alpha = pre.alpha;
    let frameTick = 0;
    const loop = () => {
      if (!running) return;
      tick(simRef.current, edgesRef.current, size, {
        ...opts,
        alpha,
        dragId: dragRef.current?.id ?? null,
      });
      alpha *= DEFAULT_ANNEAL;
      // 节流：每 2 帧才触发一次 React 渲染(~30fps)，减轻大量节点/边的渲染负担。
      if (frameTick++ % 2 === 0) setFrame((f) => f + 1);
      if (alpha >= MIN_ALPHA) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      running = false;
      cancelAnimationFrame(raf);
    };
  }, [nodes, size, dimension]);

  // 拖拽唤醒：循环停手之后拖动一个节点，其余节点原本**不会让位**（拖拽只改被拖的那个）。
  // 这里在开始拖拽时跑一段局部松弛（alpha 0.6 起、×0.94 退火 ⇒ 约 104 帧 ≈ 1.7 秒），
  // 让邻居在被拖期间让开，松手后自己停住。
  useEffect(() => {
    if (wake === 0 || nodes.length === 0 || nodes.length > MAX_FORCE) return;
    const opts: LayoutOptions = {
      clusterKey: (n) => nodeClusterKey(n as SimNode, dimension),
      pinned: pinnedIdsRef.current,
    };
    let raf = 0;
    let running = true;
    let alpha = 0.6;
    let frameTick = 0;
    const loop = () => {
      if (!running) return;
      tick(simRef.current, edgesRef.current, size, {
        ...opts,
        alpha,
        dragId: dragRef.current?.id ?? null,
      });
      alpha *= 0.94;
      if (frameTick++ % 2 === 0) setFrame((f) => f + 1);
      if (alpha >= MIN_ALPHA) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      running = false;
      cancelAnimationFrame(raf);
    };
  }, [wake]);

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
    pointerDownRef.current = { id, t: Date.now() };
    // 唤醒布局：让邻居在这段拖拽期间让位（循环停手之后本来不会动）。
    setWake((w) => w + 1);
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

  // click 事件因 setPointerCapture 派发到 svg，故在 svg 上委托；命中节点做双击检测。
  const onSvgClick = (e: React.MouseEvent) => {
    const g = (e.target as Element).closest?.(".graph-node");
    if (!g) return;
    const id = g.getAttribute("data-node-id");
    if (!id) return;
    const n = simRef.current.find((x) => x.id === id);
    if (!n) return;
    if (movedRef.current) return;
    const now = Date.now();
    if (lastClickRef.current.id === id && now - lastClickRef.current.t < 300) {
      lastClickRef.current = { id: "", t: 0 };
      openNode(n);
    } else {
      lastClickRef.current = { id, t: now };
    }
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
    // 双击检测（pointer 事件可靠，不受 setPointerCapture 影响）：节点未拖动时两次
    // 快速按下/抬起同一节点 → 打开页面。
    if (pointerDownRef.current && !movedRef.current) {
      const { id, t } = pointerDownRef.current;
      const now = Date.now();
      if (lastClickRef.current.id === id && now - t < 300) {
        lastClickRef.current = { id: "", t: 0 };
        const n = simRef.current.find((x) => x.id === id);
        if (n) openNode(n);
      } else {
        lastClickRef.current = { id, t: now };
      }
    }
    pointerDownRef.current = null;
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
    // 仅双击触发；去掉 movedRef 阻断(否则图上平移过一次后双击也被吞)。
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
        onClick={onSvgClick}
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
                onMouseEnter={() => setHoveredId(n.id)}
                onMouseLeave={() => setHoveredId((h) => (h === n.id ? null : h))}
                data-node-id={n.id}
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
          // ⚠️ 块层是**平台能力**，不是"这个空间里没有块引用"：Web 侧 `blocks_supported === false`
          //    （块层来自桌面才有的派生表 `blocks`）。改前这里只看 `graph.blocks.length`，
          //    于是 Web 用户能点开一个**永远空**的块层图、且没有任何提示。
          //    ⇒ 不支持时**禁用并说明**，而不是让用户点开一个空图。
          disabled={!graph.blocks_supported}
          title={graph.blocks_supported ? undefined : "块层仅在桌面端可用（Web 版没有块级派生）"}
        >
          块级{graph.blocks_supported && graph.blocks.length > 0 ? ` (${graph.blocks.length})` : ""}
        </button>
      </div>
    </div>
  );
}
