import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

// M25/封面 — crop editor for an uploaded cover image. Shows the image inside a
// banner-aspect crop frame; drag = pan, wheel/slider = zoom; on confirm it renders
// the visible region to a JPEG data-URI (1600 × 1600/ASPECT) and returns it.
const OUT_W = 1600;
const ASPECT = 3.5;

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

export function CoverCrop({
  src,
  onConfirm,
  onClose,
}: {
  src: string;
  onConfirm: (dataUrl: string) => void;
  onClose: () => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [box, setBox] = useState({ w: 1, h: 1 });
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ sx: number; sy: number; px: number; py: number } | null>(null);

  useEffect(() => {
    const i = new Image();
    i.onload = () => setImg(i);
    i.src = src;
    const measure = () => {
      if (boxRef.current) setBox({ w: boxRef.current.clientWidth || 1, h: boxRef.current.clientHeight || 1 });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [src]);

  const eff = useMemo(
    () => (img && box.w && box.h ? Math.max(box.w / img.naturalWidth, box.h / img.naturalHeight) * scale : 1),
    [img, box, scale],
  );

  const clampPan = (p: { x: number; y: number }) => {
    if (!img) return p;
    const maxX = Math.max(0, (img.naturalWidth * eff - box.w) / 2);
    const maxY = Math.max(0, (img.naturalHeight * eff - box.h) / 2);
    return { x: clamp(p.x, -maxX, maxX), y: clamp(p.y, -maxY, maxY) };
  };

  const onDown = (e: React.PointerEvent) => {
    drag.current = { sx: e.clientX, sy: e.clientY, px: pan.x, py: pan.y };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (drag.current) {
      const next = { x: drag.current.px + (e.clientX - drag.current.sx), y: drag.current.py + (e.clientY - drag.current.sy) };
      setPan(clampPan(next));
    }
  };
  const onUp = () => {
    drag.current = null;
  };

  const setZoom = (z: number) => {
    const z2 = clamp(z, 1, 4);
    setScale(z2);
    setPan((p) => clampPan(p));
  };

  const confirm = () => {
    if (!img) return;
    const outH = Math.round(OUT_W / ASPECT);
    const canvas = document.createElement("canvas");
    canvas.width = OUT_W;
    canvas.height = outH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const canvasScale = OUT_W / box.w;
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    ctx.drawImage(img, -pan.x * canvasScale, -pan.y * canvasScale, iw * eff * canvasScale, ih * eff * canvasScale);
    onConfirm(canvas.toDataURL("image/jpeg", 0.85));
  };

  return createPortal(
    <div
      className="crop-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="crop">
        <div className="crop-head">调整封面裁剪（拖动画面 · 滚轮/滑杆缩放）</div>
        <div className="crop-box" ref={boxRef} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}>
          {img && (
            <img
              className="crop-img"
              src={src}
              draggable={false}
              style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${eff})` }}
            />
          )}
        </div>
        <div className="crop-controls">
          <input
            type="range"
            min="1"
            max="4"
            step="0.05"
            value={scale}
            onChange={(e) => setZoom(Number(e.target.value))}
          />
        </div>
        <div className="crop-actions">
          <button className="crop-cancel" onClick={onClose}>
            取消
          </button>
          <button className="crop-ok" onClick={confirm}>
            应用
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
