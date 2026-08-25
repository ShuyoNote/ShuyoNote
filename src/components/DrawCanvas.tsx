import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

// A dependency-free HTML5 canvas paint editor (freehand + basic shapes). Avoids
// the React 19 incompatibility that broke Excalidraw's bundled Radix portals.
//
// Coordinate model: strokes are stored in NORMALIZED coords (0..1) and the canvas
// buffer is sized to its displayed size. This keeps pointer→drawing alignment
// exact at any fullscreen size (otherwise the CSS-stretched canvas misplaces the
// cursor). An existing drawing is kept as a base bitmap so redraws never erase it.

export interface DrawCanvasHandle {
  exportBlob: () => Promise<Blob | null>;
}

type Tool = "pen" | "line" | "rect" | "ellipse" | "arrow" | "eraser";

const TOOL_LABEL: Record<Tool, string> = {
  pen: "✏️",
  line: "➖",
  rect: "▭",
  ellipse: "◯",
  arrow: "➡️",
  eraser: "🧽",
};

interface Stroke {
  tool: Tool;
  color: string;
  width: number;
  points: { x: number; y: number }[];
}

const COLORS = ["#111111", "#e11d48", "#2563eb", "#16a34a", "#f59e0b", "#7c3aed", "#ffffff"];
const WIDTHS = [2, 4, 8];

const BG = "#ffffff";

function sizeCanvas(canvas: HTMLCanvasElement) {
  const r = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width));
  const h = Math.max(1, Math.round(r.height));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
}

function render(canvas: HTMLCanvasElement, strokes: Stroke[], baseImage: HTMLImageElement | null) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, w, h);
  if (baseImage) ctx.drawImage(baseImage, 0, 0, w, h);
  for (const s of strokes) drawStroke(ctx, s, w, h);
}

function normalized(canvas: HTMLCanvasElement, e: { clientX: number; clientY: number }) {
  const r = canvas.getBoundingClientRect();
  return {
    x: r.width > 0 ? (e.clientX - r.left) / r.width : 0,
    y: r.height > 0 ? (e.clientY - r.top) / r.height : 0,
  };
}

function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke, w: number, h: number) {
  if (s.points.length === 0) return;
  const pts = s.points.map((p) => ({ x: p.x * w, y: p.y * h }));
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.lineWidth = s.width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const tool: string = s.tool;
  const p0 = pts[0];
  if (tool === "pen" || tool === "eraser") {
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
    return;
  }
  const last = pts[pts.length - 1];
  if (tool === "line") {
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.lineTo(last.x, last.y);
    ctx.stroke();
  } else if (tool === "arrow") {
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.lineTo(last.x, last.y);
    ctx.stroke();
    drawArrowHead(ctx, p0, last, s.width);
  } else if (tool === "rect") {
    const x = Math.min(p0.x, last.x);
    const y = Math.min(p0.y, last.y);
    const rw = Math.abs(p0.x - last.x);
    const rh = Math.abs(p0.y - last.y);
    ctx.beginPath();
    ctx.rect(x, y, rw, rh);
    ctx.stroke();
  } else if (tool === "ellipse") {
    const cx = (p0.x + last.x) / 2;
    const cy = (p0.y + last.y) / 2;
    const rx = Math.abs(p0.x - last.x) / 2;
    const ry = Math.abs(p0.y - last.y) / 2;
    ctx.beginPath();
    ctx.ellipse(cx, cy, Math.max(1, rx), Math.max(1, ry), 0, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawArrowHead(ctx: CanvasRenderingContext2D, a: { x: number; y: number }, b: { x: number; y: number }, width: number) {
  const angle = Math.atan2(b.y - a.y, b.x - a.x);
  const len = Math.max(8, width * 3);
  ctx.beginPath();
  ctx.moveTo(b.x, b.y);
  ctx.lineTo(b.x - len * Math.cos(angle - Math.PI / 6), b.y - len * Math.sin(angle - Math.PI / 6));
  ctx.moveTo(b.x, b.y);
  ctx.lineTo(b.x - len * Math.cos(angle + Math.PI / 6), b.y - len * Math.sin(angle + Math.PI / 6));
  ctx.stroke();
}

export const DrawCanvas = forwardRef<DrawCanvasHandle, { initialImage?: string | null }>(function DrawCanvas(
  { initialImage },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const redoRef = useRef<Stroke[]>([]);
  const currentRef = useRef<Stroke | null>(null);
  const drawingRef = useRef(false);
  const baseImageRef = useRef<HTMLImageElement | null>(null);
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState(COLORS[0]);
  const [width, setWidth] = useState(4);
  const [, force] = useState(0);
  const bump = useCallback(() => force((n) => n + 1), []);
  const [hasImage, setHasImage] = useState(!!initialImage);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (canvas) render(canvas, strokesRef.current, baseImageRef.current);
  }, []);

  // Size the canvas buffer to its displayed size; redraw on resize.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    sizeCanvas(canvas);
    render(canvas, strokesRef.current, baseImageRef.current);
    const ro = new ResizeObserver(() => {
      if (!drawingRef.current) {
        sizeCanvas(canvas);
        render(canvas, strokesRef.current, baseImageRef.current);
      }
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  // Load an existing drawing (data URL) as the base bitmap.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!initialImage) {
      baseImageRef.current = null;
      setHasImage(false);
      sizeCanvas(canvas);
      render(canvas, [], null);
      return;
    }
    const im = new Image();
    im.onload = () => {
      baseImageRef.current = im;
      setHasImage(true);
      sizeCanvas(canvas);
      render(canvas, strokesRef.current, im);
    };
    im.src = initialImage;
  }, [initialImage]);

  useImperativeHandle(
    ref,
    () => ({
      exportBlob: () =>
        new Promise<Blob | null>((resolve) => {
          const canvas = canvasRef.current;
          if (!canvas) return resolve(null);
          canvas.toBlob((b) => resolve(b), "image/png");
        }),
    }),
    [],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      const canvas = canvasRef.current;
      if (!canvas) return;
      const r = canvas.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      canvas.setPointerCapture(e.pointerId);
      drawingRef.current = true;
      const stroke: Stroke = {
        tool,
        color: tool === "eraser" ? "rgba(0,0,0,0)" : color,
        width: (tool === "eraser" ? width * 3 : width) || 2,
        points: [normalized(canvas, e)],
      };
      currentRef.current = stroke;
      strokesRef.current.push(stroke);
      bump();
    },
    [tool, color, width, bump],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!drawingRef.current) return;
      const s = currentRef.current;
      const canvas = canvasRef.current;
      if (!s || !canvas) return;
      s.points.push(normalized(canvas, e));
      redraw();
    },
    [redraw],
  );

  const onPointerUp = useCallback(() => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    const s = currentRef.current;
    currentRef.current = null;
    if (s && s.points.length < 2 && s.tool !== "pen" && s.tool !== "eraser") {
      strokesRef.current = strokesRef.current.filter((x) => x !== s);
    }
    redoRef.current = [];
    bump();
  }, [bump]);

  const undo = useCallback(() => {
    if (strokesRef.current.length === 0) return;
    redoRef.current.push(strokesRef.current.pop()!);
    redraw();
    bump();
  }, [redraw, bump]);

  const redo = useCallback(() => {
    const s = redoRef.current.pop();
    if (!s) return;
    strokesRef.current.push(s);
    redraw();
    bump();
  }, [redraw, bump]);

  const clear = useCallback(() => {
    strokesRef.current = [];
    redoRef.current = [];
    baseImageRef.current = null;
    setHasImage(false);
    redraw();
    bump();
  }, [redraw, bump]);

  return (
    <div className="draw-canvas">
      <div className="draw-canvas-toolbar">
        {(["pen", "line", "rect", "ellipse", "arrow", "eraser"] as Tool[]).map((t) => (
          <button
            key={t}
            className={`draw-tool ${tool === t ? "draw-tool-active" : ""}`}
            onClick={() => setTool(t)}
            title={t}
          >
            {TOOL_LABEL[t]}
          </button>
        ))}
        <span className="draw-sep" />
        {COLORS.slice(0, 6).map((c) => (
          <button
            key={c}
            className={`draw-color ${color === c ? "draw-color-active" : ""}`}
            style={{ background: c }}
            onClick={() => {
              setColor(c);
              if (tool === "eraser") setTool("pen");
            }}
            title={c}
          />
        ))}
        <span className="draw-sep" />
        {WIDTHS.map((w) => (
          <button key={w} className={`draw-width ${width === w ? "draw-width-active" : ""}`} onClick={() => setWidth(w)}>
            <span style={{ width: w + 1, height: w + 1 }} />
          </button>
        ))}
        <span className="draw-sep" />
        <button className="draw-tool" onClick={undo} title="撤销">
          ↩
        </button>
        <button className="draw-tool" onClick={redo} title="重做">
          ↪
        </button>
        <button className="draw-tool" onClick={clear} title="清空">
          🗑
        </button>
      </div>
      <canvas
        ref={canvasRef}
        className="draw-canvas-surface"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
      {!hasImage && strokesRef.current.length === 0 ? (
        <div className="draw-canvas-hint">在此绘制</div>
      ) : null}
    </div>
  );
});
