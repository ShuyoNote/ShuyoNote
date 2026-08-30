// M26 公式 —— handwrite pad: draw a formula on a canvas, then submit it for
// recognition (→ LaTeX). Pen + eraser. Pure canvas, no dependency.
import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { PenIcon, EraserIcon, TrashIcon } from "./icons";

export function FormulaHandwritePad({ onCommit, onCancel }: {
  onCommit: (dataUrl: string) => void;
  onCancel: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [eraser, setEraser] = useState(false);
  const drawingRef = useRef(false);
  const lastRef = useRef<{ x: number; y: number } | null>(null);

  // Keep the canvas logical size matched to its displayed size × DPR so pointer
  // coordinates line up exactly. A ResizeObserver makes the drawing area follow
  // a user-driven dialog resize (preserving prior strokes via a temp canvas).
  useLayoutEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;

    const size = () => {
      const rect = c.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      const bw = Math.round(w * dpr);
      const bh = Math.round(h * dpr);
      // Preserve what's already drawn across a resize (scale into temp).
      let prev: HTMLCanvasElement | null = null;
      if (c.width && c.height) {
        prev = document.createElement("canvas");
        prev.width = c.width;
        prev.height = c.height;
        prev.getContext("2d")!.drawImage(c, 0, 0);
      }
      c.width = bw;
      c.height = bh;
      const ctx = c.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, w, h);
      if (prev) {
        // Re-canvas is now cleared; redraw the (scaled) previous snapshot.
        ctx.drawImage(prev, 0, 0, prev.width, prev.height, 0, 0, w, h);
      }
    };

    size();
    const ro = new ResizeObserver(size);
    ro.observe(c);
    return () => ro.disconnect();
  }, []);

  const pos = (e: React.PointerEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const down = (e: React.PointerEvent) => {
    // Capture on the canvas so moves track the pointer even outside bounds.
    e.currentTarget.setPointerCapture(e.pointerId);
    drawingRef.current = true;
    lastRef.current = pos(e);
  };
  const move = (e: React.PointerEvent) => {
    // Read the ref (not state) so high-frequency moves stay in sync — state updates
    // are async/batched and would drop strokes.
    if (!drawingRef.current) return;
    const ctx = canvasRef.current!.getContext("2d")!;
    const p = pos(e);
    const last = lastRef.current ?? p;
    ctx.strokeStyle = eraser ? "#fff" : "#111";
    ctx.lineWidth = eraser ? 18 : 3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    lastRef.current = p;
  };
  const up = () => { drawingRef.current = false; };

  const submit = () => {
    onCommit(canvasRef.current!.toDataURL("image/png"));
  };

  return createPortal(
    <div className="handwrite-overlay" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="handwrite" onMouseDown={(e) => e.stopPropagation()}>
        <div className="handwrite-head">
          <span className="handwrite-title">书写公式（提交识别为 LaTeX）</span>
          <button className="handwrite-close" title="关闭" onClick={onCancel}>×</button>
        </div>
        <canvas
          ref={canvasRef}
          className="handwrite-canvas"
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
        />
        <div className="handwrite-foot">
          <div className="handwrite-left">
            <button className={`handwrite-tool ${eraser ? "" : "active"}`} onClick={() => setEraser(false)} title="笔" aria-label="笔">
              <PenIcon width={17} height={17} />
            </button>
            <button className={`handwrite-tool ${eraser ? "active" : ""}`} onClick={() => setEraser(true)} title="橡皮" aria-label="橡皮">
              <EraserIcon width={17} height={17} />
            </button>
            <button className="handwrite-tool" onClick={() => { const c = canvasRef.current!; const ctx = c.getContext("2d")!; const dpr = window.devicePixelRatio || 1; ctx.save(); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width / dpr, c.height / dpr); ctx.restore(); }} title="清空" aria-label="清空">
              <TrashIcon width={17} height={17} />
            </button>
          </div>
          <div className="handwrite-right">
            <button className="handwrite-btn" onClick={onCancel}>取消</button>
            <button className="handwrite-btn handwrite-btn-primary" onClick={submit}>提交识别</button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
