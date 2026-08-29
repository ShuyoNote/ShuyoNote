import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
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
import type { AnnotTool, PdfPageController, PdfPageState } from "./pdfAnnotController";

// M24 — a single annotated PDF page. Renders the page image (from `pageImageUrl`)
// under an SVG overlay; annotations are stored normalized (0..1 in page pixel
// space) and drawn in page-pixel space via the viewBox. Adds highlight/ink/sticky,
// lets you select + delete an annotation, and "摘录成块" turns a selection into a
// new page carrying the `pdf://` back-ref (the "批注即块" differentiator).
//
// 方案 B — 工具栏已提升到阅读器顶部（唯一一份）。本组件只负责页面本身：
// 工具选择（tool）是受控的（由父级共享），批注/选中/撤销/AI/OCR/便签等仍留在页内，
// 并通过 registerController 把句柄暴露给顶部工具栏调用。

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
  /** 受控工具选择（由顶部工具栏共享）。 */
  tool: AnnotTool;
  onToolChange: (t: AnnotTool) => void;
  /** 挂载时注册本页句柄，卸载时传 null 注销。 */
  registerController?: (pageIndex: number, ctl: PdfPageController | null) => void;
  /** 本页批注状态变化（新增/删除/选中/撤销等）时触发，顶部工具栏据此刷新。 */
  onStateChange?: () => void;
  /** 批注被持久化保存后触发（新增/删除/编辑/移动/撤销），父级据此刷新右侧批注侧栏。 */
  onChanged?: () => void;
}

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

// 标注「实际绘制区域」的像素坐标 [px, py, pw, ph]。选中描边须与绘制的图形一致：
// 便签实际画的是固定 ~26px 方块（取自 box 左上角），不是 box 的 0.04×0.06 长条；
// 高亮/矩形按 box 的 x0..x1；墨迹按 points 包围盒。
function drawBoxPx(ann: PdfAnnotation, W: number, H: number): [number, number, number, number] | null {
  if (ann.type === "sticky" && ann.box) {
    const w = Math.min(26, W * 0.06);
    const h = Math.min(26, H * 0.06);
    return [ann.box[0] * W, ann.box[1] * H, w, h];
  }
  if ((ann.type === "highlight" || ann.type === "rect") && ann.box) {
    const [x0, y0, x1, y1] = ann.box;
    return [x0 * W, y0 * H, (x1 - x0) * W, (y1 - y0) * H];
  }
  if (ann.points && ann.points.length) {
    const xs = ann.points.map((p) => p[0]);
    const ys = ann.points.map((p) => p[1]);
    return [(Math.min(...xs)) * W, (Math.min(...ys)) * H, (Math.max(...xs) - Math.min(...xs)) * W, (Math.max(...ys) - Math.min(...ys)) * H];
  }
  return null;
}

export function PdfAnnotationCanvas({ attachmentId, pageIndex, pageW, pageH, pageImageUrl, hasTextLayer, textItems, focusTarget, onFocusConsumed, tool, onToolChange, registerController, onStateChange, onChanged }: Props) {
  const [annotations, setAnnotations] = useState<PdfAnnotation[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [ocrText, setOcrText] = useState<string | null>(null);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiPreview, setAiPreview] = useState<string | null>(null);
  const [editBox, setEditBox] = useState<[number, number] | null>(null); // 内联便签气泡位置（归一化）
  const [editText, setEditText] = useState("");
  const [flash, setFlash] = useState<[number, number, number, number] | null>(null); // 侧栏跳转的临时高亮框
  // 正在拖动便签：用于切换光标为「正在抓取」(grabbing)，并让选中描边/便签跟随。
  const [draggingSticky, setDraggingSticky] = useState(false);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const drag = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const ink = useRef<[number, number][]>([]);
  // C8 便签拖动：记录被拖动的便签 id + 起点（归一化），用于把便签色块拖到新位置。
  const moveSticky = useRef<{ id: string; box: [number, number, number, number]; originBox: [number, number, number, number]; sx: number; sy: number } | null>(null);
  const [, force] = useState(0);

  // 页面参考像素尺寸（SVG viewBox 坐标空间），顶部声明以便各 effect 复用。
  const W = Math.max(pageW, 1);
  const H = Math.max(pageH, 1);

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
    // 闪烁框须贴合「实际绘制几何」：便签画的是固定 ~26px 方块（锚点为 box 左上角），
    // 而非其 0.04×0.06 的逻辑 box；高亮/矩形按 box；墨迹按 points 包围盒。
    // 统一用 drawBoxPx 计算，避免便签跳转时描边与实际色块错位。
    const d = drawBoxPx(focusTarget.ann, W, H);
    if (d) {
      const [px, py, pw, ph] = d;
      setFlash([px / W, py / H, (px + pw) / W, (py + ph) / H]);
      const t = window.setTimeout(() => setFlash(null), 1600);
      onFocusConsumed?.();
      return () => window.clearTimeout(t);
    }
    // 无几何（理论上不会）则退化为选中该标注。
    if (focusTarget.ann.id) {
      setSelected(focusTarget.ann.id);
      onFocusConsumed?.();
    }
  }, [focusTarget, pageIndex, onFocusConsumed, W, H]);

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
      onChanged?.();
    },
    [attachmentId, pageIndex, onChanged],
  );

  // A2 撤销：本页批注的历史快照栈（局部、在内存，不改持久化语义）。
  const canUndo = undoStackRef.current.length > 0;
  const undo = () => {
    const prev = undoStackRef.current.pop();
    if (!prev) return;
    setAnnotations(prev);
    setSelected(null);
    void api.savePdfAnnotations(attachmentId, pageIndex, prev).catch(() => {});
    onChanged?.();
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
      // C8 — select 工具下按住便签即直接拖动（同时选中），无需先点选一次再拖。
      if (hit && hit.type === "sticky" && hit.box) {
        // 记录拖动起点的框（originBox，固定）与起点坐标；后续用 originBox + (p - 起点) 计算，
        // 保证跟手且不累积放大（此前把位移加到每帧变化的 box 上导致"飞了"）。
        moveSticky.current = { id: hit.id, box: hit.box, originBox: hit.box, sx: p.x, sy: p.y };
        setSelected(hit.id);
        setDraggingSticky(true);
        // 光标即时切换为「正在抓取」（imperative，立即生效；React state 异步会滞后）。
        e.currentTarget.style.cursor = "grabbing";
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
      // 基准 = 拖动起点的框（originBox 固定），位移 = 当前指针 - 起点指针。
      // 这样跟手、不累积放大。
      const dx = p.x - m.sx;
      const dy = p.y - m.sy;
      const [ox0, oy0, ox1, oy1] = m.originBox;
      const w = ox1 - ox0;
      const h = oy1 - oy0;
      moveSticky.current = { ...m, box: [ox0 + dx, oy0 + dy, ox0 + dx + w, oy0 + dy + h] };
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
      setDraggingSticky(false);
      // 恢复光标（清掉 imperative grabbing，回到当前工具对应光标：选择=箭头，绘制=crosshair）。
      svgRef.current && (svgRef.current.style.cursor = tool === "select" ? "default" : "crosshair");
      redraw();
      return;
    }
    if (tool === "ink" && ink.current.length >= 2) {
      persist([...annotations, { id: `i-${Date.now()}`, type: "ink", points: ink.current }]);
      ink.current = [];
      redraw();
      onToolChange("select"); // A1 — 画完自动回选择
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
        onToolChange("select"); // A1 — 画完自动回选择
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
    onToolChange("select"); // A1 — 便签保存/取消后回选择
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

  // 6 — 把本页全部批注导出为一块笔记（含 pdf:// 回链）。正文 = 每条批注文本
  //（便签正文 / 文本层相交文字 / 墨迹点数），无文本则跳过。
  const onExportAnnotations = async () => {
    if (!annotations.length) return;
    const lines: string[] = [];
    for (const a of annotations) {
      let text = (a as { text?: string }).text?.trim() ?? "";
      if (!text && a.box && textItems?.length) {
        text = textInBox([a.box[0] * pageW, a.box[1] * pageH, a.box[2] * pageW, a.box[3] * pageH], textItems);
      }
      const label = a.type === "sticky" ? "便签" : a.type === "highlight" ? "高亮" : a.type === "ink" ? "画笔" : a.type === "rect" ? "区域" : "批注";
      const item = text ? `【${label}】${text}` : `【${label}】（${pageIndex + 1} 页）`;
      if (item) lines.push(item);
    }
    const body = lines.join("\n");
    const block = pageToBlock({ text: body }, attachmentId, pageIndex);
    const notes = useNotes.getState();
    try {
      if (notes.current && notes.current.id) {
        const { contentTextOf } = await import("../lib/ai/lexical");
        const blockNode = JSON.parse(block.content_json).root.children[0];
        const doc = JSON.parse(notes.current.content_json || '{"root":{"children":[],"type":"root","version":1}}');
        doc.root.children.push(blockNode);
        const newJson = JSON.stringify(doc);
        await api.savePage({ id: notes.current.id, content_json: newJson, content_text: contentTextOf(newJson) });
        await notes.openPage(notes.current.id);
        toast(`已导出本页 ${annotations.length} 条批注到当前页`, "success");
      } else {
        await notes.createPage(null, { title: `PDF 批注 · 第 ${pageIndex + 1} 页`, content_json: block.content_json, content_text: block.content_text });
        toast(`已导出本页 ${annotations.length} 条批注到新页面`, "success");
      }
    } catch {
      await notes.createPage(null, { title: `PDF 批注 · 第 ${pageIndex + 1} 页`, content_json: block.content_json, content_text: block.content_text });
      toast("已导出批注到新页面", "success");
    }
  };

  // 方案 B — 把本页句柄暴露给顶部工具栏（作用于当前页）。
  // 用 ref 持有最新方法，注册一个稳定控制器（避免每次渲染都触发父级副作用）。
  const selectedAnn = selected ? annotations.find((a) => a.id === selected) : null;
  const ctlRef = useRef<PdfPageController | null>(null);
  const latest = useRef({ annotations, selected, selectedAnn, canUndo, tool });
  latest.current = { annotations, selected, selectedAnn, canUndo, tool };
  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;

  useEffect(() => {
    if (!registerController) return;
    const ctl: PdfPageController = {
      getState: (): PdfPageState => {
        const cur = latest.current;
        return {
          selected: cur.selected,
          selectedType: cur.selectedAnn?.type ?? null,
          annotationsCount: cur.annotations.length,
          canUndo: cur.canUndo,
          hasTextLayer,
          aiBusy,
        };
      },
      setTool: (t: AnnotTool) => onToolChange(t),
      undo,
      exportAnnotations: onExportAnnotations,
      deleteSelected: onDelete,
      excerpt: onExcerpt,
      aiRead: onAiRead,
      copyRef: onCopyRef,
      editSticky: onEditSticky,
      runOcr,
      notify: () => {
        // 状态变化：提示顶部工具栏重读 getState()。
        onStateChangeRef.current?.();
      },
    };
    ctlRef.current = ctl;
    registerController(pageIndex, ctl);
    return () => registerController(pageIndex, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageIndex, registerController, hasTextLayer, aiBusy]);

  // 本页批注/选中/可撤销状态变化 → 通知顶部工具栏刷新。
  useEffect(() => {
    onStateChange?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [annotations, selected, canUndo, onStateChange]);

  return (
    <div className="pdf-annot">
      <div
        className="pdf-annot-stage"
        style={{ position: "relative" }}
        onPointerDown={(e) => {
          // 2 — 点页面外的空白处取消选中（SVG 内点击由下方 onDown 处理，不走到这）。
          if (e.target === e.currentTarget) setSelected(null);
        }}
      >
        {pageImageUrl ? (
          <img className="pdf-annot-img" src={pageImageUrl} alt={`第 ${pageIndex + 1} 页`} draggable={false} />
        ) : (
          <div className="pdf-annot-placeholder">第 {pageIndex + 1} 页</div>
        )}
        <svg
          ref={svgRef}
          className="pdf-annot-svg"
          style={{ cursor: tool === "select" ? "default" : "crosshair" }}
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
              // 拖动中的便签用 moveSticky.current.box 实时定位（跟随指针），否则用 state 的 box。
              const dragBox = moveSticky.current?.id === a.id ? moveSticky.current.box : null;
              const box = dragBox ?? a.box;
              return (
                <g key={a.id} style={{ cursor: draggingSticky ? "grabbing" : tool === "select" ? "grab" : undefined }}>
                  <rect x={box[0] * W} y={box[1] * H} width={Math.min(26, W * 0.06)} height={Math.min(26, H * 0.06)} fill="#ffe28a" stroke="#d9b400" />
                  <title>{a.text}</title>
                </g>
              );
            }
            return null;
          })}
          {/* 选中标注的高亮描边框：让"选中"状态可视，并与实际绘制的图形精确对齐。 */}
          {selectedAnn && (() => {
            const draggingSticky = moveSticky.current?.id === selected;
            // 拖动中的便签用 moveSticky 起点 + 固定尺寸；否则按实际绘制区域。
            let px: number, py: number, pw: number, ph: number;
            if (draggingSticky) {
              const bb = moveSticky.current!.box;
              px = bb[0] * W; py = bb[1] * H;
              pw = Math.min(26, W * 0.06); ph = Math.min(26, H * 0.06);
            } else {
              const d = drawBoxPx(selectedAnn, W, H);
              if (!d) return null;
              [px, py, pw, ph] = d;
            }
            const pad = Math.max(2, Math.min(W, H) * 0.004);
            return (
              <>
                {/* 外圈：柔和半透明蓝光晕，包裹实际绘制区域 */}
                <rect
                  x={px - pad}
                  y={py - pad}
                  width={pw + pad * 2}
                  height={ph + pad * 2}
                  rx={6}
                  fill="rgba(51,112,255,0.14)"
                  stroke="none"
                  style={{ pointerEvents: "none" }}
                />
                {/* 内圈：细实线圆角边框 */}
                <rect
                  x={px - pad * 0.6}
                  y={py - pad * 0.6}
                  width={pw + pad * 1.2}
                  height={ph + pad * 1.2}
                  rx={5}
                  fill="none"
                  stroke={draggingSticky ? "rgba(51,112,255,0.95)" : "rgba(51,112,255,0.8)"}
                  strokeWidth={draggingSticky ? 2 : 1.6}
                  strokeLinejoin="round"
                  style={{ pointerEvents: "none" }}
                />
              </>
            );
          })()}
          {/* 拖拽中的实时预览（不跟随 state，边拖边显示高亮框 / 墨迹） */}
          {drag.current && tool !== "ink" && (
            (() => {
              const d = drag.current;
              const x0 = Math.min(d.x0, d.x1) * W;
              const y0 = Math.min(d.y0, d.y1) * H;
              const w = Math.abs(d.x1 - d.x0) * W;
              const h = Math.abs(d.y1 - d.y0) * H;
              return (
                <rect x={x0} y={y0} width={w} height={h} fill={highlightColor} stroke="rgba(51,112,255,0.6)" strokeWidth={1.5} style={{ pointerEvents: "none" }} />
              );
            })()
          )}
          {tool === "ink" && ink.current.length >= 2 && (
            <polyline
              points={ink.current.map(([x, y]) => `${x * W},${y * H}`).join(" ")}
              fill="none"
              stroke="rgba(51,112,255,0.85)"
              strokeWidth={2.5}
              strokeLinecap="round"
              style={{ pointerEvents: "none" }}
            />
          )}
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
                  onToolChange("select");
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
                  onToolChange("select");
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
