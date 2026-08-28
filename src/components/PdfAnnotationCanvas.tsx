import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { api } from "../lib/api";
import { type PdfAnnotation, normCoords, pageToBlock, pdfRef } from "../lib/pdfAnnotation";
import { snapHighlightToText, type TextItemLike } from "../lib/pdfTextLayer";
import { useNotes } from "../store/notes";
import { usePdfReader } from "../store/pdfReader";
import { toast } from "../store/toast";

// M24 — a single annotated PDF page. Renders the page image (from `pageImageUrl`)
// under an SVG overlay; annotations are stored normalized (0..1 in page pixel
// space) and drawn in page-pixel space via the viewBox. Adds highlight/ink/sticky,
// lets you select + delete an annotation, and "摘录成块" turns a selection into a
// new page carrying the `pdf://` back-ref (the "批注即块" differentiator).

interface Props {
  attachmentId: string;
  pageIndex: number;
  pageW: number;
  pageH: number;
  pageImageUrl: string | null;
  hasTextLayer: boolean;
  textItems?: TextItemLike[] | null;
}

type Tool = "select" | "highlight" | "ink" | "sticky";
const highlightColor = "rgba(255, 214, 0, 0.35)";

function loadPage(attachmentId: string, pageIndex: number): Promise<PdfAnnotation[]> {
  return api
    .listPdfAnnotations(attachmentId)
    .then((rows) => (rows.find((r) => r.page_index === pageIndex)?.annotations as PdfAnnotation[]) ?? [])
    .catch(() => []);
}

function contains(ann: PdfAnnotation, x: number, y: number): boolean {
  if (ann.box) {
    const [x0, y0, x1, y1] = ann.box;
    return x >= x0 && x <= x1 && y >= y0 && y <= y1;
  }
  if (ann.points) {
    return ann.points.some(([px, py]) => Math.hypot(px - x, py - y) < 0.03);
  }
  return false;
}

export function PdfAnnotationCanvas({ attachmentId, pageIndex, pageW, pageH, pageImageUrl, hasTextLayer, textItems }: Props) {
  const [annotations, setAnnotations] = useState<PdfAnnotation[]>([]);
  const [tool, setTool] = useState<Tool>("select");
  const [selected, setSelected] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const drag = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const ink = useRef<[number, number][]>([]);
  const [, force] = useState(0);

  useEffect(() => {
    let alive = true;
    setAnnotations([]);
    setSelected(null);
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
    if (tool === "select") {
      const p = toNorm(e);
      const hit = annotations.find((a) => contains(a, p.x, p.y));
      setSelected(hit?.id ?? null);
      return;
    }
    setSelected(null);
    if (tool === "sticky") {
      const p = toNorm(e);
      const text = window.prompt("便签内容：");
      if (text == null) return;
      persist([...annotations, { id: `s-${Date.now()}`, type: "sticky", box: [p.x, p.y, p.x + 0.04, p.y + 0.06], text }]);
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
      persist([...annotations, { id: `i-${Date.now()}`, type: "ink", points: ink.current }]);
      ink.current = [];
      redraw();
    } else if (drag.current) {
      const { x0, y0, x1, y1 } = drag.current;
      if (Math.abs(x1 - x0) > 0.005 || Math.abs(y1 - y0) > 0.005) {
        // 有文本层时，把高亮吸附到实际文字字框（精确划词）；否则用原始拖框。
        let box = normCoords(x0 * pageW, y0 * pageH, x1 * pageW, y1 * pageH, pageW, pageH);
        if (hasTextLayer && textItems && textItems.length) {
          const snapped = snapHighlightToText([x0 * pageW, y0 * pageH, x1 * pageW, y1 * pageH], textItems, pageW, pageH);
          if (snapped) box = snapped;
        }
        persist([...annotations, { id: `h-${Date.now()}`, type: "highlight", box }]);
      }
      drag.current = null;
      redraw();
    }
  };

  const onDelete = () => {
    if (!selected) return;
    persist(annotations.filter((a) => a.id !== selected));
    setSelected(null);
  };

  const onEditSticky = () => {
    const ann = annotations.find((a) => a.id === selected);
    if (!ann || ann.type !== "sticky") return;
    const v = window.prompt("便签内容：", ann.text ?? "");
    if (v == null) return;
    persist(annotations.map((a) => (a.id === ann.id ? { ...a, text: v } : a)));
  };

  const onCopyRef = async () => {
    await navigator.clipboard.writeText(pdfRef(attachmentId, pageIndex));
    toast("已复制 PDF 引用", "success");
  };

  const onExcerpt = async () => {
    const ann = annotations.find((a) => a.id === selected);
    if (!ann) return;
    let text = (ann as { text?: string }).text ?? "";
    if (!text.trim()) {
      const v = window.prompt("摘录内容：");
      if (v == null) return;
      text = v;
    }
    if (!text.trim()) return;
    const block = pageToBlock({ text }, attachmentId, pageIndex);
    const notes = useNotes.getState();
    if (notes.current && notes.current.id) {
      // Insert into the current page as a block carrying the pdf:// ref (=> 可点击回链).
      try {
        const { contentTextOf } = await import("../lib/ai/lexical");
        const blockNode = JSON.parse(block.content_json).root.children[0];
        const doc = JSON.parse(notes.current.content_json || '{"root":{"children":[],"type":"root","version":1}}');
        doc.root.children.push(blockNode);
        const newJson = JSON.stringify(doc);
        await api.savePage({ id: notes.current.id, content_json: newJson, content_text: contentTextOf(newJson) });
        await notes.openPage(notes.current.id);
        toast("已摘录到当前页", "success");
      } catch {
        await notes.createPage(null, { title: "摘录", content_json: block.content_json, content_text: block.content_text });
        toast("已摘录到新页面", "success");
      }
    } else {
      await notes.createPage(null, { title: "摘录", content_json: block.content_json, content_text: block.content_text });
      toast("已摘录到新页面", "success");
    }
    setSelected(null);
    usePdfReader.getState().close();
  };

  const W = Math.max(pageW, 1);
  const H = Math.max(pageH, 1);

  const tools: { id: Tool; label: string }[] = [
    { id: "select", label: "选择" },
    { id: "highlight", label: "高亮" },
    { id: "ink", label: "画笔" },
    { id: "sticky", label: "便签" },
  ];
  const selectedAnn = selected ? annotations.find((a) => a.id === selected) : null;

  return (
    <div className="pdf-annot">
      <div className="pdf-annot-tools">
        {tools.map((t) => (
          <button key={t.id} className={`pdf-annot-tool ${tool === t.id ? "active" : ""}`} onClick={() => setTool(t.id)}>
            {t.label}
          </button>
        ))}
        {selected && (
          <>
            <span className="pdf-annot-sep" />
            <button className="pdf-annot-tool" onClick={onExcerpt}>摘录成块</button>
            {selectedAnn?.type === "sticky" && <button className="pdf-annot-tool" onClick={onEditSticky}>编辑</button>}
            <button className="pdf-annot-tool" onClick={onCopyRef}>复制引用</button>
            <button className="pdf-annot-tool danger" onClick={onDelete}>删除</button>
          </>
        )}
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
