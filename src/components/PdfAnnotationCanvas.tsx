import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { api } from "../lib/api";
import { type PdfAnnotation, normCoords, pageToBlock, pdfRef } from "../lib/pdfAnnotation";
import { snapHighlightToText, textInBox, type TextItemLike } from "../lib/pdfTextLayer";
import { ocrRecognize } from "../lib/ocr";
import { runInlineDraft } from "../lib/ai/inlineDraft";
import type { ProviderConfig } from "../lib/ai/llm";
import { useAiStore } from "../store/ai";
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
  focusTarget?: { pageIndex: number; ann: PdfAnnotation } | null;
  onFocusConsumed?: () => void;
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

export function PdfAnnotationCanvas({ attachmentId, pageIndex, pageW, pageH, pageImageUrl, hasTextLayer, textItems, focusTarget, onFocusConsumed }: Props) {
  const [annotations, setAnnotations] = useState<PdfAnnotation[]>([]);
  const [tool, setTool] = useState<Tool>("select");
  const [selected, setSelected] = useState<string | null>(null);
  const [ocrText, setOcrText] = useState<string | null>(null);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiPreview, setAiPreview] = useState<string | null>(null);
  const [editBox, setEditBox] = useState<[number, number] | null>(null); // 内联便签气泡位置（归一化）
  const [editText, setEditText] = useState("");
  const [flash, setFlash] = useState<[number, number, number, number] | null>(null); // 侧栏跳转的临时高亮框
  const svgRef = useRef<SVGSVGElement | null>(null);
  const drag = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const ink = useRef<[number, number][]>([]);
  // C8 便签拖动：记录被拖动的便签 id + 起点（归一化），用于把便签色块拖到新位置。
  const moveSticky = useRef<{ id: string; box: [number, number, number, number]; sx: number; sy: number } | null>(null);
  const [, force] = useState(0);

  useEffect(() => {
    let alive = true;
    setAnnotations([]);
    setSelected(null);
    setOcrText(null);
    loadPage(attachmentId, pageIndex).then((a) => {
      if (alive) setAnnotations(a);
    });
    return () => {
      alive = false;
    };
  }, [attachmentId, pageIndex]);

  // 侧栏跳转：目标在本文档当前页则闪烁定位到该标注（临时描边），随后消费 target。
  useEffect(() => {
    if (!focusTarget) return;
    if (focusTarget.pageIndex !== pageIndex) return;
    const box = focusTarget.ann.box;
    if (box) {
      setFlash([box[0], box[1], box[2], box[3]]);
      const t = window.setTimeout(() => setFlash(null), 1600);
      onFocusConsumed?.();
      return () => window.clearTimeout(t);
    }
    // 无 box（如 ink）则退化为选中该标注。
    if (focusTarget.ann.id) {
      setSelected(focusTarget.ann.id);
      onFocusConsumed?.();
    }
  }, [focusTarget, pageIndex, onFocusConsumed]);

  const runOcr = async () => {
    if (!pageImageUrl || ocrBusy) return;
    setOcrBusy(true);
    setOcrText(null);
    const text = await ocrRecognize(pageImageUrl);
    setOcrText(text);
    setOcrBusy(false);
    if (text) toast("已识别本页文本", "success");
  };

  const undoStackRef = useRef<PdfAnnotation[][]>([]);
  const persist = useCallback(
    (next: PdfAnnotation[]) => {
      setAnnotations((prev) => {
        // A2 撤销：每次变更前把旧快照压栈（仅当确有变化，避免把空压栈）。
        if (JSON.stringify(prev) !== JSON.stringify(next)) {
          undoStackRef.current.push(prev);
          if (undoStackRef.current.length > 50) undoStackRef.current.shift();
        }
        return next;
      });
      void api.savePdfAnnotations(attachmentId, pageIndex, next).catch(() => {});
    },
    [attachmentId, pageIndex],
  );

  // A2 撤销：本页批注的历史快照栈（局部、在内存，不改持久化语义）。
  const canUndo = undoStackRef.current.length > 0;
  const undo = () => {
    const prev = undoStackRef.current.pop();
    if (!prev) return;
    setAnnotations(prev);
    setSelected(null);
    void api.savePdfAnnotations(attachmentId, pageIndex, prev).catch(() => {});
    toast("已撤销", "success");
  };

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
      // C8 — 若命中的是已选中的便签，则进入「拖动便签」模式；否则仅选中。
      if (hit && selected && hit.id === selected && hit.type === "sticky" && hit.box) {
        moveSticky.current = { id: hit.id, box: hit.box, sx: p.x, sy: p.y };
        svgRef.current?.setPointerCapture?.(e.pointerId);
        return;
      }
      setSelected(hit?.id ?? null);
      return;
    }
    setSelected(null);
    if (tool === "sticky") {
      const p = toNorm(e);
      setEditBox([p.x, p.y]);
      setEditText("");
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
    if (moveSticky.current) {
      const p = toNorm(e);
      const m = moveSticky.current;
      const dx = p.x - m.sx;
      const dy = p.y - m.sy;
      const w = m.box[2] - m.box[0];
      const h = m.box[3] - m.box[1];
      moveSticky.current = { ...m, box: [m.box[0] + dx, m.box[1] + dy, m.box[0] + dx + w, m.box[1] + dy + h] };
      redraw();
      return;
    }
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
    // C8 — 便签拖动结束时持久化新位置（钳制到 [0,1]）。
    if (moveSticky.current) {
      const m = moveSticky.current;
      const clamp = (v: number) => Math.max(0, Math.min(1, v));
      const nx0 = clamp(m.box[0]);
      const ny0 = clamp(m.box[1]);
      const nx1 = clamp(m.box[2]);
      const ny1 = clamp(m.box[3]);
      const moved = [nx0, ny0, nx1, ny1] as [number, number, number, number];
      persist(annotations.map((a) => (a.id === m.id ? { ...a, box: moved } : a)));
      moveSticky.current = null;
      redraw();
      return;
    }
    if (tool === "ink" && ink.current.length >= 2) {
      persist([...annotations, { id: `i-${Date.now()}`, type: "ink", points: ink.current }]);
      ink.current = [];
      redraw();
      setTool("select"); // A1 — 画完自动回选择
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
        setTool("select"); // A1 — 画完自动回选择
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
    if (!ann || ann.type !== "sticky" || !ann.box) return;
    setEditBox([ann.box[0], ann.box[1]]);
    setEditText(ann.text ?? "");
  };

  // 内联便签气泡：确定 → 保存；无内容且是新便签 → 丢弃；编辑则更新。
  const commitSticky = () => {
    if (!editBox) return;
    const text = editText.trim();
    const box: [number, number, number, number] = [editBox[0], editBox[1], editBox[0] + 0.04, editBox[1] + 0.06];
    if (selected) {
      if (!text) {
        persist(annotations.filter((a) => a.id !== selected));
      } else {
        persist(annotations.map((a) => (a.id === selected ? { ...a, text } : a)));
      }
    } else if (text) {
      persist([...annotations, { id: `s-${Date.now()}`, type: "sticky", box, text }]);
    }
    setEditBox(null);
    setEditText("");
    setSelected(null);
    setTool("select"); // A1 — 便签保存/取消后回选择
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

  const onAiRead = async () => {
    const ann = annotations.find((a) => a.id === selected);
    if (!ann) return;
    // 从选中标注提取待理解文本：便签正文优先；否则用文本层 items 里与该标注框相交的文字。
    let source = (ann as { text?: string }).text?.trim() ?? "";
    if (!source && ann.box && textItems?.length) {
      source = textInBox([ann.box[0] * pageW, ann.box[1] * pageH, ann.box[2] * pageW, ann.box[3] * pageH], textItems);
    }
    if (!source.trim()) {
      toast("未选中可理解的文字（可先高亮文字或添加便签）", "error");
      return;
    }
    setAiBusy(true);
    setAiPreview(null);
    try {
      const config = useAiStore.getState().config as unknown as ProviderConfig;
      const notes = useNotes.getState();
      const allPages = useNotes.getState().pages ?? [];
      const ctx = {
        currentPageId: notes.currentId,
        allPages: allPages.map((p: any) => ({ id: p.id, title: p.title, parent_id: p.parent_id ?? null })),
      };
      const res = await runInlineDraft(
        config,
        `请总结下面这段 PDF 摘录的要点，用简洁的中文分点说明；不要复述原文，不要任何开场/结尾语。\n\n【摘录】\n${source.slice(0, 4000)}`,
        allPages.map((p: any) => ({ id: p.id, title: p.title })),
        ctx,
        { onDelta: (t) => { setAiPreview((prev) => (prev ?? "") + t); } },
      );
      const summary = (res.reply ?? "").trim();
      if (summary) {
        // 生成带 pdf:// 回链的块：先建摘要块，再附一个 pdfref（复用摘录块的附件引用语义）。
        const ref = pdfRef(attachmentId, pageIndex);
        const label = `AI 帮读 · 第 ${pageIndex + 1} 页`;
        const block = pageToBlock({ text: summary }, attachmentId, pageIndex);
        // 改写成「摘要文本 + pdfref 回链」的段落：直接复用摘录块（已含 pdfref）。
        if (notes.current && notes.current.id) {
          try {
            const { contentTextOf } = await import("../lib/ai/lexical");
            const blockNode = JSON.parse(block.content_json).root.children[0];
            const doc = JSON.parse(notes.current.content_json || '{"root":{"children":[],"type":"root","version":1}}');
            doc.root.children.push(blockNode);
            const newJson = JSON.stringify(doc);
            await api.savePage({ id: notes.current.id, content_json: newJson, content_text: contentTextOf(newJson) });
            await notes.openPage(notes.current.id);
            toast("AI 帮读已写入当前页", "success");
          } catch {
            await notes.createPage(null, { title: label, content_json: block.content_json, content_text: [summary, ref].filter(Boolean).join(" ") });
            toast("AI 帮读已生成到新页面", "success");
          }
        } else {
          await notes.createPage(null, { title: label, content_json: block.content_json, content_text: [summary, ref].filter(Boolean).join(" ") });
          toast("AI 帮读已生成到新页面", "success");
        }
        setSelected(null);
        usePdfReader.getState().close();
      } else {
        toast(res.error ?? "AI 未返回内容", "error");
      }
    } catch (e) {
      toast(`AI 帮读失败：${(e as Error)?.message ?? e}`, "error");
    }
    setAiBusy(false);
  };

  const W = Math.max(pageW, 1);
  const H = Math.max(pageH, 1);

  // 工具栏：图标 + 文案，强化可发现性与激活态。
  const tools: { id: Tool; label: string; hint: string; icon: ReactNode }[] = [
    {
      id: "select",
      label: "选择",
      hint: "点击选中已有标注",
      icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 4l7.5 16 2-6.5L20 11.5z" /></svg>,
    },
    {
      id: "highlight",
      label: "高亮",
      hint: "拖选文字/区域高亮（有文本层会精确划词）",
      icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M9 11l4 4L19 9a2 2 0 0 0-3-3l-6 6H9z" /><path d="M9 11l-3-3M16 20H8" /></svg>,
    },
    {
      id: "ink",
      label: "画笔",
      hint: "自由手绘标注",
      icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 19l7-7a2 2 0 0 0-3-3l-7 7v3h3z" /><path d="M18 3l1 1" /></svg>,
    },
    {
      id: "sticky",
      label: "便签",
      hint: "在页面任意处添加便签",
      icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 5h16v10l-5 5H4z" /><path d="M15 20v-5h5" /></svg>,
    },
  ];
  const selectedAnn = selected ? annotations.find((a) => a.id === selected) : null;

  return (
    <div className="pdf-annot">
      <div className="pdf-annot-toolbar">
        <div className="pdf-annot-tools" role="toolbar" aria-label="批注工具">
          {tools.map((t) => (
            <button
              key={t.id}
              className={`pdf-annot-tool ${tool === t.id ? "active" : ""}`}
              onClick={() => setTool(t.id)}
              title={t.hint}
              aria-pressed={tool === t.id}
            >
              <span className="pdf-annot-tool-icon">{t.icon}</span>
              <span className="pdf-annot-tool-label">{t.label}</span>
            </button>
          ))}
          {/* A2 撤销：撤销本页最后一次批注变更 */}
          <button
            className={`pdf-annot-tool ${canUndo ? "" : "disabled"}`}
            onClick={undo}
            disabled={!canUndo}
            title="撤销上次批注"
          >
            <span className="pdf-annot-tool-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M3 7v6h6M3 13a9 9 0 1 0 3-7.7L3 13" /></svg>
            </span>
            <span className="pdf-annot-tool-label">撤销</span>
          </button>
        </div>
        <div className="pdf-annot-actions">
          {selected && selectedAnn ? (
            <>
              <button className="pdf-annot-tool accent" onClick={onExcerpt} title="把选中内容摘录为笔记块（含 pdf:// 回链）">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" /></svg>
                <span>摘录成块</span>
              </button>
              <button className="pdf-annot-tool accent" onClick={onAiRead} disabled={aiBusy} title="AI 总结这段 PDF 文字，生成笔记块（含 pdf:// 回链）">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l1.7 4.6L18 9l-4.3 1.4L12 15l-1.7-4.6L6 9l4.3-1.4z" /><path d="M19 14l.9 2.1L22 17l-2.1.9L19 20l-.9-2.1L16 17l2.1-.9z" /></svg>
                <span>{aiBusy ? "AI 中…" : "AI 帮读"}</span>
              </button>
              {selectedAnn.type === "sticky" && (
                <button className="pdf-annot-tool" onClick={onEditSticky} title="编辑便签内容">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
                  <span>编辑</span>
                </button>
              )}
              <button className="pdf-annot-tool" onClick={onCopyRef} title="复制 PDF 引用（可粘贴到别处回链）">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>
                <span>复制引用</span>
              </button>
              <button className="pdf-annot-tool danger" onClick={onDelete} title="删除选中标注">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></svg>
                <span>删除</span>
              </button>
            </>
          ) : (
            <span className="pdf-annot-tip">先在页面选中一条标注，即可摘录、复制引用或删除</span>
          )}
        </div>
      </div>

      {/* 页面能力提示条：文本层状态 + OCR（无文本层时） */}
      <div className="pdf-annot-status">
        <span className={`pdf-annot-layer ${hasTextLayer ? "ok" : "warn"}`}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            {hasTextLayer ? <path d="M20 6L9 17l-5-5" /> : <path d="M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />}
          </svg>
          {hasTextLayer ? "有文本层，可精确划词" : "无文本层，建议用矩形/画笔/便签"}
        </span>
        {!hasTextLayer && (
          <button className="pdf-annot-ocr" onClick={runOcr} disabled={ocrBusy}>
            {ocrBusy ? "识别中…" : "OCR 识别本页"}
          </button>
        )}
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
          {/* 侧栏跳转定位时的临时闪烁框 */}
          {flash && (
            <rect
              x={flash[0] * W}
              y={flash[1] * H}
              width={(flash[2] - flash[0]) * W}
              height={(flash[3] - flash[1]) * H}
              fill="none"
              stroke="rgba(51,112,255,0.95)"
              strokeWidth={3}
              strokeDasharray="6 4"
              style={{ pointerEvents: "none", animation: "pdf-flash 1.4s ease-out forwards" }}
            />
          )}
        </svg>

        {/* 内联便签气泡：替换 window.prompt，粘贴在页面内即时编辑 */}
        {editBox && (
          <div
            className="pdf-sticky-editor"
            style={{ left: `${editBox[0] * 100}%`, top: `${editBox[1] * 100}%` }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <textarea
              className="pdf-sticky-input"
              autoFocus
              placeholder="输入便签内容…"
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  commitSticky();
                } else if (e.key === "Escape") {
                  setEditBox(null);
                  setEditText("");
                  setSelected(null);
                  setTool("select");
                }
              }}
              rows={3}
            />
            <div className="pdf-sticky-actions">
              <button className="pdf-sticky-btn ok" onClick={commitSticky}>保存</button>
              <button
                className="pdf-sticky-btn"
                onClick={() => {
                  setEditBox(null);
                  setEditText("");
                  setSelected(null);
                  setTool("select");
                }}
              >
                取消
              </button>
            </div>
          </div>
        )}
      </div>

      {ocrText && (
        <div className="pdf-ocr-result">
          <div className="pdf-ocr-title">OCR 识别结果</div>
          <textarea className="pdf-ocr-text" readOnly value={ocrText} onFocus={(e) => e.currentTarget.select()} spellCheck={false} />
        </div>
      )}

      {(aiBusy || aiPreview) && (
        <div className="pdf-ai-result">
          <div className="pdf-ai-title">AI 帮读（{aiBusy ? "生成中…" : "预览"}）</div>
          <div className="pdf-ai-body">{aiPreview || "正在阅读选中段落…"}</div>
        </div>
      )}
    </div>
  );
}
