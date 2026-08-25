import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

// A dependency-free HTML5 canvas paint editor (freehand + basic shapes). Avoids
// the React 19 incompatibility that broke Excalidraw's bundled Radix portals.
// Scene = a list of strokes that are re-rendered onto the canvas each change, so
// undo/redo and clear are trivial and memory-light. Exports a PNG blob.

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

function render(canvas: HTMLCanvasElement, strokes: Stroke[]) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (const s of strokes) drawStroke(ctx, s);
}

function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke) {
  if (s.points.length === 0) return;
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.lineWidth = s.width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const tool: string = s.tool;
  const p0 = s.points[0];
  if (tool === "pen" || tool === "eraser") {
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x, s.points[i].y);
    ctx.stroke();
    return;
  }
  const last = s.points[s.points.length - 1];
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
    const w = Math.abs(p0.x - last.x);
    const h = Math.abs(p0.y - last.y);
    ctx.beginPath();
    ctx.rect(x, y, w, h);
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

function strokeCanvasRect(canvas: HTMLCanvasElement): DOMRect {
  return canvas.getBoundingClientRect();
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
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState(COLORS[0]);
  const [width, setWidth] = useState(4);
  const [, force] = useState(0);
  const bump = useCallback(() => force((n) => n + 1), []);
  const [hasImage, setHasImage] = useState(!!initialImage);

  // Load existing drawing (data URL) onto the canvas.
  const loadInitial = useCallback((img?: string | null) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!img) {
      render(canvas, []);
      strokesRef.current = [];
      setHasImage(false);
      return;
    }
    const im = new Image();
    im.onload = () => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(im, 0, 0, canvas.width, canvas.height);
      setHasImage(true);
    };
    im.src = img;
  }, []);

  // Set initial image once (when the modal opens).
  const initRef = useRef(false);
  if (canvasRef.current && !initRef.current && initialImage) {
    initRef.current = true;
    loadInitial(initialImage);
  }

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (canvas) render(canvas, strokesRef.current);
  }, []);

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

  const pointFrom = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = strokeCanvasRect(canvasRef.current!);
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.setPointerCapture(e.pointerId);
      drawingRef.current = true;
      const stroke: Stroke = {
        tool,
        color: tool === "eraser" ? "rgba(0,0,0,0)" : color,
        width: (tool === "eraser" ? width * 3 : width) || 2,
        points: [pointFrom(e)],
      };
      currentRef.current = stroke;
      strokesRef.current.push(stroke);
      bump();
    },
    [tool, color, width, pointFrom, bump],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!drawingRef.current) return;
      const s = currentRef.current;
      if (!s) return;
      s.points.push(pointFrom(e));
      redraw();
    },
    [pointFrom, redraw],
  );

  const onPointerUp = useCallback(() => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    const s = currentRef.current;
    currentRef.current = null;
    // Drop an empty gesture (a click with no movement) for shape tools.
    if (s && s.tool !== "pen" && s.tool !== "eraser" && s.points.length < 2) {
      strokesRef.current = strokesRef.current.filter((x) => x !== s);
    }
    redoRef.current = [];
    bump();
  }, [bump]);

  const undo = useCallback(() => {
    if (strokesRef.current.length === 0) return;
    const s = strokesRef.current.pop()!;
    redoRef.current.push(s);
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
    redraw();
    setHasImage(false);
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
        width={960}
        height={540}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={onPointerUp}
      />
      {!hasImage && strokesRef.current.length === 0 ? (
        <div className="draw-canvas-hint">在此绘制</div>
      ) : null}
    </div>
  );
});
