import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { platform } from "../lib/platform";
import { api } from "../lib/api";
import {
  emptyScene,
  newLayer,
  uid,
  fitView,
  sceneToSvg,
  normRect,
  polygonPoints,
  NATURAL_W,
  NATURAL_H,
  type Scene,
  type Shape,
  type Layer,
  type View,
  type Pt,
} from "../lib/scene";
import { inputDialog } from "../store/input";
import { useAiStore } from "../store/ai";
import { buildImageGenUrl, buildImageGenBody, parseImageGenResponse, b64ToBytes, bytesToDataUrl } from "../lib/ai/imageGen";
import { toast } from "../store/toast";

// A dependency-free HTML5 vector drawing editor: layers + shapes + text + image +
// pannable/zoomable viewport. Shapes stored in WORLD coords; a view transform maps
// world→screen so the cursor stays aligned at any zoom/pan. Exports PNG (block
// preview) and SVG (vector).

export interface DrawCanvasHandle {
  exportBlob: () => Promise<Blob | null>;
  exportSvg: () => string;
}

type Tool = "pen" | "line" | "rect" | "ellipse" | "triangle" | "diamond" | "pentagon" | "star" | "arrow" | "text" | "hand" | "eraser";

const TOOLS: { key: Tool; label: string }[] = [
  { key: "pen", label: "✏️" },
  { key: "line", label: "➖" },
  { key: "rect", label: "▭" },
  { key: "ellipse", label: "◯" },
  { key: "triangle", label: "△" },
  { key: "diamond", label: "◇" },
  { key: "pentagon", label: "⬠" },
  { key: "star", label: "☆" },
  { key: "arrow", label: "➡️" },
  { key: "text", label: "T" },
  { key: "hand", label: "✋" },
  { key: "eraser", label: "🧽" },
];

const COLORS = ["#111111", "#e11d48", "#2563eb", "#16a34a", "#f59e0b", "#7c3aed", "#ffffff"];
const WIDTHS = [2, 4, 8];
const TEXT_SIZES = [14, 20, 28, 40];
const BG = "#ffffff";

function sizeCanvas(canvas: HTMLCanvasElement) {
  const r = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width));
  const h = Math.max(1, Math.round(r.height));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
}

function drawShape(ctx: CanvasRenderingContext2D, s: Shape, imgCache: Map<string, HTMLImageElement>) {
  if (s.kind === "pen") {
    if (s.points.length < 2) return;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.globalCompositeOperation = s.erase ? "destination-out" : "source-over";
    ctx.beginPath();
    ctx.moveTo(s.points[0].x, s.points[0].y);
    for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x, s.points[i].y);
    ctx.stroke();
    ctx.globalCompositeOperation = "source-over";
    return;
  }
  if (s.kind === "text") {
    ctx.font = `${s.size}px system-ui, sans-serif`;
    ctx.fillStyle = s.color;
    ctx.textBaseline = "top";
    ctx.fillText(s.text, s.pos.x, s.pos.y);
    return;
  }
  if (s.kind === "image") {
    const img = imgCache.get(s.src);
    if (img) ctx.drawImage(img, s.x, s.y, s.w, s.h);
    return;
  }
  ctx.strokeStyle = s.color;
  ctx.lineWidth = s.width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (s.kind === "line") {
    ctx.beginPath();
    ctx.moveTo(s.a.x, s.a.y);
    ctx.lineTo(s.b.x, s.b.y);
    ctx.stroke();
    return;
  }
  if (s.kind === "arrow") {
    ctx.beginPath();
    ctx.moveTo(s.a.x, s.a.y);
    ctx.lineTo(s.b.x, s.b.y);
    ctx.stroke();
    const ang = Math.atan2(s.b.y - s.a.y, s.b.x - s.a.x);
    const len = Math.max(8, s.width * 3);
    ctx.beginPath();
    ctx.moveTo(s.b.x, s.b.y);
    ctx.lineTo(s.b.x - len * Math.cos(ang - Math.PI / 6), s.b.y - len * Math.sin(ang - Math.PI / 6));
    ctx.moveTo(s.b.x, s.b.y);
    ctx.lineTo(s.b.x - len * Math.cos(ang + Math.PI / 6), s.b.y - len * Math.sin(ang + Math.PI / 6));
    ctx.stroke();
    return;
  }
  if (s.kind === "rect") {
    const r = normRect(s.a, s.b);
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    return;
  }
  if (s.kind === "ellipse") {
    const r = normRect(s.a, s.b);
    ctx.beginPath();
    ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, Math.max(1, r.w / 2), Math.max(1, r.h / 2), 0, 0, Math.PI * 2);
    ctx.stroke();
    return;
  }
  const pts = polygonPoints(s.kind, s.a, s.b);
  if (pts.length === 0) return;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  ctx.stroke();
}

function render(canvas: HTMLCanvasElement, scene: Scene, view: View, imgCache: Map<string, HTMLImageElement>) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  sizeCanvas(canvas);
  const w = canvas.width;
  const h = canvas.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, w, h);
  ctx.setTransform(view.zoom, 0, 0, view.zoom, view.x, view.y);
  for (const layer of scene.layers) {
    if (!layer.visible) continue;
    for (const s of layer.shapes) drawShape(ctx, s, imgCache);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function screenToWorld(view: View, canvas: HTMLCanvasElement, e: { clientX: number; clientY: number }): Pt {
  const r = canvas.getBoundingClientRect();
  const sx = e.clientX - r.left;
  const sy = e.clientY - r.top;
  return { x: (sx - view.x) / view.zoom, y: (sy - view.y) / view.zoom };
}

function preload(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("图片加载失败"));
    img.src = src;
  });
}

export const DrawCanvas = forwardRef<DrawCanvasHandle, { initialImage?: string | null }>(function DrawCanvas(
  { initialImage },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<Scene>(emptyScene());
  const viewRef = useRef<View>({ x: 0, y: 0, zoom: 1 });
  const imgCache = useRef<Map<string, HTMLImageElement>>(new Map());
  const drawingRef = useRef(false);
  const currentShapeRef = useRef<Shape | null>(null);
  const panRef = useRef<{ sx: number; sy: number; vx: number; vy: number } | null>(null);
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState(COLORS[0]);
  const [width, setWidth] = useState(4);
  const [textSize, setTextSize] = useState(20);
  const [activeLayer, setActiveLayer] = useState<string>(() => sceneRef.current.layers[0].id);
  const [textEdit, setTextEdit] = useState<{ pos: Pt; value: string } | null>(null);
  const [svgAvailable, setSvgAvailable] = useState(false);
  const [, force] = useState(0);
  const bump = useCallback(() => force((n) => n + 1), []);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (canvas) render(canvas, sceneRef.current, viewRef.current, imgCache.current);
  }, []);

  const activeShapeLayer = useCallback((): Layer => {
    const s = sceneRef.current;
    return s.layers.find((l) => l.id === activeLayer) ?? s.layers[0];
  }, [activeLayer]);

  // Size + initial fixture on mount.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    sizeCanvas(canvas);
    const ro = new ResizeObserver(() => {
      if (!drawingRef.current && !panRef.current) redraw();
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [redraw]);

  // Load existing drawing (PNG) as an image shape and frame it.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!initialImage) {
      sceneRef.current = emptyScene();
      setActiveLayer(sceneRef.current.layers[0].id);
      viewRef.current = fitView(sceneRef.current, { w: canvas.width || 800, h: canvas.height || 500 });
      redraw();
      return;
    }
    preload(initialImage)
      .then((img) => {
        imgCache.current.set(initialImage, img);
        const scale = Math.min(NATURAL_W / img.width, NATURAL_H / img.height, 2);
        const iw = img.width * scale;
        const ih = img.height * scale;
        const shape: Shape = { kind: "image", x: 0, y: 0, w: iw, h: ih, src: initialImage };
        sceneRef.current = { layers: [{ id: uid(), name: "图层 1", visible: true, shapes: [shape] }] };
        setActiveLayer(sceneRef.current.layers[0].id);
        viewRef.current = fitView(sceneRef.current, { w: canvas.width || 800, h: canvas.height || 500 });
        redraw();
      })
      .catch(() => {
        sceneRef.current = emptyScene();
        redraw();
      });
  }, [initialImage, redraw]);

  useImperativeHandle(
    ref,
    () => ({
      exportBlob: () =>
        new Promise<Blob | null>((resolve) => {
          const canvas = canvasRef.current;
          if (!canvas) return resolve(null);
          sizeCanvas(canvas);
          render(canvas, sceneRef.current, viewRef.current, imgCache.current);
          canvas.toBlob((b) => resolve(b), "image/png");
        }),
      exportSvg: () => sceneToSvg(sceneRef.current).svg,
    }),
    [],
  );

  // ---- pointer handlers ------------------------------------------------------
  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.setPointerCapture(e.pointerId);
      const r = canvas.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      if (tool === "hand") {
        panRef.current = { sx: e.clientX, sy: e.clientY, vx: viewRef.current.x, vy: viewRef.current.y };
        return;
      }
      if (tool === "text") {
        const pos = screenToWorld(viewRef.current, canvas, e);
        setTextEdit({ pos, value: "" });
        return;
      }
      drawingRef.current = true;
      const p = screenToWorld(viewRef.current, canvas, e);
      if (tool === "pen" || tool === "eraser") {
        currentShapeRef.current = {
          kind: "pen",
          color,
          width: tool === "eraser" ? width * 3 : width,
          erase: tool === "eraser",
          points: [p],
        };
      } else {
        currentShapeRef.current = { kind: tool, color, width, a: p, b: p };
      }
      activeShapeLayer().shapes.push(currentShapeRef.current as Shape);
    },
    [tool, color, width, activeShapeLayer],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      if (panRef.current) {
        const pr = panRef.current;
        viewRef.current = { ...viewRef.current, x: pr.vx + (e.clientX - pr.sx), y: pr.vy + (e.clientY - pr.sy) };
        redraw();
        return;
      }
      if (!drawingRef.current || !currentShapeRef.current) return;
      const p = screenToWorld(viewRef.current, canvas, e);
      const s = currentShapeRef.current;
      if (s.kind === "pen") s.points.push(p);
      else if ("b" in s) s.b = p; // shapes use a→b
      redraw();
    },
    [redraw],
  );

  const onPointerUp = useCallback(() => {
    drawingRef.current = false;
    panRef.current = null;
    currentShapeRef.current = null;
    bump();
  }, [bump]);

  const onWheel = useCallback(
    (e: React.WheelEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      const canvas = canvasRef.current;
      if (!canvas) return;
      const r = canvas.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      const v = viewRef.current;
      const k2 = Math.min(16, Math.max(0.05, v.zoom * (e.deltaY < 0 ? 1.1 : 0.9)));
      const wx = (mx - v.x) / v.zoom;
      const wy = (my - v.y) / v.zoom;
      viewRef.current = { x: mx - wx * k2, y: my - wy * k2, zoom: k2 };
      redraw();
    },
    [redraw],
  );

  const fit = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    viewRef.current = fitView(sceneRef.current, { w: canvas.width || 800, h: canvas.height || 500 });
    redraw();
  }, [redraw]);

  const zoomBy = useCallback(
    (f: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const v = viewRef.current;
      const k2 = Math.min(16, Math.max(0.05, v.zoom * f));
      const cx = canvas.width / 2;
      const cy = canvas.height / 2;
      const wx = (cx - v.x) / v.zoom;
      const wy = (cy - v.y) / v.zoom;
      viewRef.current = { x: cx - wx * k2, y: cy - wy * k2, zoom: k2 };
      redraw();
    },
    [redraw],
  );

  // ---- text commit ----------------------------------------------------------
  const commitText = useCallback(() => {
    if (!textEdit) return;
    const t = textEdit.value.trim();
    if (t) {
      activeShapeLayer().shapes.push({ kind: "text", color, size: textSize, pos: textEdit.pos, text: t });
      bump();
    }
    setTextEdit(null);
  }, [textEdit, color, textSize, activeShapeLayer, bump]);

  // ---- image / AI / mermaid --------------------------------------------------
  const placeImage = useCallback(
    (src: string) => {
      preload(src)
        .then((img) => {
          imgCache.current.set(src, img);
          const scale = Math.min(720 / img.width, 480 / img.height, 2);
          const iw = img.width * scale;
          const ih = img.height * scale;
          const v = viewRef.current;
          const canvas = canvasRef.current;
          const cx = canvas ? (canvas.width / 2 - v.x) / v.zoom : NATURAL_W / 2;
          const cy = canvas ? (canvas.height / 2 - v.y) / v.zoom : NATURAL_H / 2;
          activeShapeLayer().shapes.push({ kind: "image", x: cx - iw / 2, y: cy - ih / 2, w: iw, h: ih, src });
          bump();
        })
        .catch(() => toast("图片加载失败", "error"));
    },
    [activeShapeLayer, bump],
  );

  const insertImage = useCallback(async () => {
    const picked = await platform.dialog.open({ title: "插入图片", multiple: false, filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }] });
    if (!picked) return;
    const path = Array.isArray(picked) ? picked[0] : picked;
    try {
      const metas = await api.importAttachmentFiles(null, [path]);
      const src = platform.asset.convertFileSrc(metas[0].path);
      placeImage(src);
    } catch (e) {
      toast(`插入图片失败：${e}`, "error");
    }
  }, [placeImage]);

  const aiDraw = useCallback(async () => {
    const { config } = useAiStore.getState();
    if (!config.enabled || config.provider !== "openai") {
      toast("AI 绘图需在设置里启用并配置 OpenAI 兼容文生图端点", "error");
      return;
    }
    inputDialog({
      title: "AI 绘图",
      placeholder: "描述你想生成的画面…",
      okLabel: "生成",
      onSubmit: async (prompt) => {
        const p = (prompt ?? "").trim();
        if (!p) return;
        try {
          const res = await fetch(buildImageGenUrl(config.baseUrl), {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
            body: buildImageGenBody(config, p),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const parsed = parseImageGenResponse(await res.text());
          if (!parsed) throw new Error("响应中没有图片数据");
          let dataUrl: string;
          if ("b64" in parsed) {
            dataUrl = bytesToDataUrl(b64ToBytes(parsed.b64), parsed.mime);
          } else {
            dataUrl = parsed.url;
          }
          placeImage(dataUrl);
        } catch (e) {
          toast(`AI 绘图失败：${e}`, "error");
        }
      },
    });
  }, [placeImage]);

  const mermaidDraw = useCallback(async () => {
    inputDialog({
      title: "流程图 / 思维导图",
      placeholder: "graph TD\n  A[开始] --> B[结束]",
      okLabel: "生成",
      onSubmit: async (srcText) => {
        const src = (srcText ?? "").trim();
        if (!src) return;
        try {
          const mod = await import("mermaid");
          const mermaid = mod.default;
          mermaid.initialize({ startOnLoad: false, theme: "default" });
          const id = `sn-${Math.random().toString(36).slice(2, 10)}`;
          const { svg } = await mermaid.render(id, src);
          const blob = new Blob([svg], { type: "image/svg+xml" });
          const url = URL.createObjectURL(blob);
          const dataUrl = await new Promise<string>((resolve) => {
            const img = new Image();
            img.onload = () => {
              const c = document.createElement("canvas");
              c.width = img.naturalWidth + 20;
              c.height = img.naturalHeight + 20;
              const ctx = c.getContext("2d");
              if (ctx) ctx.drawImage(img, 10, 10);
              resolve(c.toDataURL("image/png"));
              URL.revokeObjectURL(url);
            };
            img.src = url;
          });
          placeImage(dataUrl);
        } catch (e) {
          toast(`生成流程图失败：${e}`, "error");
        }
      },
    });
  }, [placeImage]);

  // ---- layer ops -------------------------------------------------------------
  const setLayers = useCallback(
    (next: Layer[]) => {
      sceneRef.current = { ...sceneRef.current, layers: next };
      bump();
    },
    [bump],
  );

  const addLayer = useCallback(() => {
    const scene = sceneRef.current;
    const l = newLayer(`图层 ${scene.layers.length + 1}`);
    setLayers([...scene.layers, l]);
    setActiveLayer(l.id);
  }, [setLayers]);

  const moveLayer = useCallback(
    (dir: -1 | 1) => {
      const layers = sceneRef.current.layers;
      const i = layers.findIndex((l) => l.id === activeLayer);
      if (i < 0) return;
      const j = i + dir;
      if (j < 0 || j >= layers.length) return;
      const next = [...layers];
      [next[i], next[j]] = [next[j], next[i]];
      setLayers(next);
    },
    [activeLayer, setLayers],
  );

  const toggleLayer = useCallback(
    (id: string) => {
      setLayers(sceneRef.current.layers.map((l) => (l.id === id ? { ...l, visible: !l.visible } : l)));
    },
    [setLayers],
  );

  const deleteLayer = useCallback(() => {
    if (sceneRef.current.layers.length <= 1) {
      toast("至少保留一个图层", "error");
      return;
    }
    const next = sceneRef.current.layers.filter((l) => l.id !== activeLayer);
    setLayers(next);
    setActiveLayer(next[next.length - 1].id);
  }, [activeLayer, setLayers]);

  const layerLabel = (l: Layer) => l.name;

  // ---- view helpers ----------------------------------------------------------
  const textScreen = textEdit ? { left: textEdit.pos.x * viewRef.current.zoom + viewRef.current.x, top: textEdit.pos.y * viewRef.current.zoom + viewRef.current.y } : null;

  return (
    <div className="draw-canvas">
      <div className="draw-canvas-toolbar">
        {TOOLS.map((t) => (
          <button key={t.key} className={`draw-tool ${tool === t.key ? "draw-tool-active" : ""}`} onClick={() => setTool(t.key)} title={t.key}>
            {t.label}
          </button>
        ))}
        <span className="draw-sep" />
        {COLORS.slice(0, 6).map((c) => (
          <button key={c} className={`draw-color ${color === c ? "draw-color-active" : ""}`} style={{ background: c }} onClick={() => { setColor(c); if (tool === "eraser") setTool("pen"); }} title={c} />
        ))}
        <span className="draw-sep" />
        {WIDTHS.map((w) => (
          <button key={w} className={`draw-width ${width === w ? "draw-width-active" : ""}`} onClick={() => setWidth(w)}><span style={{ width: w + 1, height: w + 1 }} /></button>
        ))}
        <span className="draw-sep" />
        {TEXT_SIZES.map((s) => (
          <button key={s} className={`draw-width ${textSize === s ? "draw-width-active" : ""}`} onClick={() => setTextSize(s)} title={`字号 ${s}`}>{s}</button>
        ))}
        <span className="draw-sep" />
        <button className="draw-tool" onClick={() => zoomBy(1.15)} title="放大">＋</button>
        <button className="draw-tool" onClick={() => zoomBy(0.85)} title="缩小">－</button>
        <button className="draw-tool" onClick={fit} title="适应内容">⤢</button>
        <button className="draw-tool" onClick={insertImage} title="插入图片">🖼</button>
        <button className="draw-tool" onClick={aiDraw} title="AI 插图">🤖</button>
        <button className="draw-tool" onClick={mermaidDraw} title="流程图/思维导图">📊</button>
        <button className="draw-tool" onClick={() => setSvgAvailable(true)} title="导出 SVG">⇩</button>
      </div>
      <div className="draw-canvas-layers">
        <button className="draw-layers-btn" onClick={addLayer} title="新增图层">＋图层</button>
        {sceneRef.current.layers.map((l) => (
          <div key={l.id} className={`draw-layer ${l.id === activeLayer ? "draw-layer-active" : ""} ${l.visible ? "" : "draw-layer-hidden"}`} onClick={() => setActiveLayer(l.id)}>
            <button className="draw-layer-vis" title="显示/隐藏" onClick={(e) => { e.stopPropagation(); toggleLayer(l.id); }}>{l.visible ? "👁" : "🚫"}</button>
            <span className="draw-layer-name">{layerLabel(l)}</span>
            <button className="draw-layer-op" title="上移" onClick={(e) => { e.stopPropagation(); moveLayer(1); }}>↑</button>
            <button className="draw-layer-op" title="下移" onClick={(e) => { e.stopPropagation(); moveLayer(-1); }}>↓</button>
            <button className="draw-layer-op" title="删除图层" onClick={(e) => { e.stopPropagation(); deleteLayer(); }}>×</button>
          </div>
        ))}
      </div>
      <div className="draw-canvas-stage">
        <canvas
          ref={canvasRef}
          className="draw-canvas-surface"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={onWheel}
        />
        {textEdit && textScreen ? (
          <input
            className="draw-canvas-text-input"
            style={{ left: textScreen.left, top: textScreen.top }}
            autoFocus
            value={textEdit.value}
            onChange={(e) => setTextEdit({ ...textEdit, value: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); commitText(); }
              if (e.key === "Escape") setTextEdit(null);
            }}
            onBlur={commitText}
            placeholder="输入文字"
          />
        ) : null}
        {svgAvailable ? (
          <div className="draw-canvas-export">
            <button className="drawing-modal-btn" onClick={() => downloadText("drawing.svg", sceneToSvg(sceneRef.current).svg)}>另存 SVG</button>
            <button className="drawing-modal-btn" onClick={() => setSvgAvailable(false)}>关闭</button>
          </div>
        ) : null}
      </div>
    </div>
  );
});

function downloadText(name: string, text: string) {
  const blob = new Blob([text], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
