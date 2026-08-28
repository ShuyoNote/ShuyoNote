import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { api } from "../lib/api";
import { type PdfAnnotation, normCoords } from "../lib/pdfAnnotation";

// M24 — a single annotated PDF page. Renders the page image (from `pageImageUrl`)
// under an SVG overlay; annotations are stored normalized (0..1 in page pixel
// space) and drawn in page-pixel space via the viewBox. Adds highlight/ink/sticky
// and persists the page's list through `api.savePdfAnnotations`.

interface Props {
  attachmentId: string;
  pageIndex: number;
  pageW: number;
  pageH: number;
  pageImageUrl: string | null;
  hasTextLayer: boolean;
}

const highlightColor = "rgba(255, 214, 0, 0.35)";

function loadPage(attachmentId: string, pageIndex: number): Promise<PdfAnnotation[]> {
  return api
    .listPdfAnnotations(attachmentId)
    .then((rows) => rows.find((r) => r.page_index === pageIndex)?.annotations as PdfAnnotation[] ?? [])
    .catch(() => []);
}

export function PdfAnnotationCanvas({ attachmentId, pageIndex, pageW, pageH, pageImageUrl, hasTextLayer }: Props) {
  const [annotations, setAnnotations] = useState<PdfAnnotation[]>([]);
  const [tool, setTool] = useState<"highlight" | "ink" | "sticky">("highlight");
  const svgRef = useRef<SVGSVGElement | null>(null);
  const drag = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const ink = useRef<[number, number][]>([]);
  const [, force] = useState(0);

  useEffect(() => {
    let alive = true;
    setAnnotations([]);
    loadPage(attachmentId, pageIndex).then((a) => {
      if (alive) setAnnotations(a);
    });
    return () => {
      alive = false;
    };
  }, [attachmentId, pageIndex]);

  const persist = useCallback(
    (next: PdfAnnotation[]) => {
      setAnnotations(next);
      void api.savePdfAnnotations(attachmentId, pageIndex, next).catch(() => {});
    },
    [attachmentId, pageIndex],
  );

  const toNorm = (e: { clientX: number; clientY: number }) => {
    const el = svgRef.current;
    if (!el) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };

  const redraw = () => force((n) => n + 1);

  const onDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    e.preventDefault();
    if (tool === "sticky") {
      const p = toNorm(e);
      const id = `s-${Date.now()}`;
      const text = window.prompt("便签内容：");
      if (text == null) return;
      persist([...annotations, { id, type: "sticky", box: [p.x, p.y, p.x + 0.04, p.y + 0.06], text }]);
      return;
    }
    const p = toNorm(e);
    svgRef.current?.setPointerCapture?.(e.pointerId);
    if (tool === "ink") {
      ink.current = [[p.x, p.y]];
    } else {
      drag.current = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    }
  };

  const onMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (tool === "ink" && ink.current.length) {
      const p = toNorm(e);
      ink.current.push([p.x, p.y]);
      redraw();
    } else if (drag.current) {
      const p = toNorm(e);
      drag.current.x1 = p.x;
      drag.current.y1 = p.y;
      redraw();
    }
  };

  const onUp = () => {
    if (tool === "ink" && ink.current.length >= 2) {
      const id = `i-${Date.now()}`;
      persist([...annotations, { id, type: "ink", points: ink.current }]);
      ink.current = [];
      redraw();
    } else if (drag.current) {
      const { x0, y0, x1, y1 } = drag.current;
      if (Math.abs(x1 - x0) > 0.005 || Math.abs(y1 - y0) > 0.005) {
        const box = normCoords(x0 * pageW, y0 * pageH, x1 * pageW, y1 * pageH, pageW, pageH);
        const id = `h-${Date.now()}`;
        persist([...annotations, { id, type: "highlight", box }]);
      }
      drag.current = null;
      redraw();
    }
  };

  const W = Math.max(pageW, 1);
  const H = Math.max(pageH, 1);

  return (
    <div className="pdf-annot">
      <div className="pdf-annot-tools">
        {(["highlight", "ink", "sticky"] as const).map((t) => (
          <button
            key={t}
            className={`pdf-annot-tool ${tool === t ? "active" : ""}`}
            onClick={() => setTool(t)}
          >
            {t === "highlight" ? "高亮" : t === "ink" ? "画笔" : "便签"}
          </button>
        ))}
        <span className="pdf-annot-hint">{hasTextLayer ? "有文本层" : "无文本层（矩形/画笔/便签更稳）"}</span>
      </div>

      <div className="pdf-annot-stage" style={{ position: "relative" }}>
        {pageImageUrl ? (
          <img className="pdf-annot-img" src={pageImageUrl} alt={`第 ${pageIndex + 1} 页`} draggable={false} />
        ) : (
          <div className="pdf-annot-placeholder">第 {pageIndex + 1} 页</div>
        )}
        <svg
          ref={svgRef}
          className="pdf-annot-svg"
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerLeave={onUp}
        >
          {annotations.map((a) => {
            if (a.type === "ink" && a.points) {
              const pts = a.points.map(([x, y]) => `${x * W},${y * H}`).join(" ");
              return <polyline key={a.id} points={pts} fill="none" stroke="rgba(51,112,255,0.85)" strokeWidth={2.5} strokeLinecap="round" />;
            }
            if ((a.type === "highlight" || a.type === "rect") && a.box) {
              const [x0, y0, x1, y1] = a.box;
              return (
                <rect
                  key={a.id}
                  x={x0 * W}
                  y={y0 * H}
                  width={(x1 - x0) * W}
                  height={(y1 - y0) * H}
                  fill={a.type === "highlight" ? highlightColor : "none"}
                  stroke={a.type === "rect" ? "rgba(51,112,255,0.85)" : "transparent"}
                />
              );
            }
            if (a.type === "sticky" && a.box) {
              return (
                <g key={a.id}>
                  <rect x={a.box[0] * W} y={a.box[1] * H} width={Math.min(26, W * 0.06)} height={Math.min(26, H * 0.06)} fill="#ffe28a" stroke="#d9b400" />
                  <title>{a.text}</title>
                </g>
              );
            }
            return null;
          })}
        </svg>
      </div>
    </div>
  );
}
