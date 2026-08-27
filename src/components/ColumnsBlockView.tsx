import { useCallback, useEffect, useRef, useState } from "react";
import { ColumnEditor } from "./ColumnEditor";
import { EMPTY_COLUMN_JSON } from "../editor/nodes/ColumnsBlockNode";

// Route B: renders N independent column editors in a flex row. Each column owns its
// own EditorState (JSON). Local state mirrors the cols prop so structural changes
// (add/remove) reflect immediately; each change is pushed up via onChange. Optional
// per-column widths are adjustable by dragging the divider (flex-grow weights).

const MIN_COLS = 1;
const MAX_COLS = 4;
// Minimum flex-grow weight for a column so the drag can never make it vanish
// (or the neighbour). Keep it small relative to the default 1 so up to 4 columns
// can all shrink meaningfully.
const MIN_W = 0.25;

function shareWeight(widths: number[], idx: number, total: number): number {
  // Default to equal weight (1) so columns share the container evenly; explicit
  // widths otherwise. Using flex-grow weights (not % bases) lets flexbox distribute
  // the space INCLUDING the gap, so columns never overflow the container.
  if (widths.length === total) return widths[idx] ?? 1;
  return 1;
}

const colWidths = (widths: number[], total: number): number[] => {
  const w = widths.length === total ? widths.slice() : Array(total).fill(1);
  return w;
};

export function ColumnsBlockView({
  cols,
  widths = [],
  pageId,
  onChange,
  onWidthsChange,
}: {
  cols: string[]; // one serialized EditorState JSON per column
  widths?: number[]; // optional flex-grow weight per column; empty/partial => equal
  pageId: string;
  onChange?: (cols: string[]) => void;
  onWidthsChange?: (widths: number[]) => void;
}) {
  // Divider at idx sits on the boundary between column idx (left) and idx+1 (right).
  // Dragging rebalances the left/right PAIR — the left column grows and the right
  // shrinks by the same weight — so the cursor tracks the boundary 1:1 and the other
  // columns don't shift at all. Total is preserved, so nothing overflows.
  const [localCols, setLocalCols] = useState<string[]>(cols);
  const [localWidths, setLocalWidths] = useState<number[]>(widths);
  // While a divider is dragged, each column's top-right shows its current share (%).
  // The whole drag is driven by React state (pixel widths) so the DOM and React never
  // fight — a single source of truth. `dragWidths` is null when idle.
  const [dragWidths, setDragWidths] = useState<number[] | null>(null);
  const dragWidthsRef = useRef<number[] | null>(null);
  const dragRef = useRef<{
    idx: number;
    startX: number;
    startLeftPx: number; // left column's pixel width at drag start
    pairPx: number; // combined width of the two columns, incl. the gap between them
    pairWeight: number; // combined flex-grow weight of the two columns at drag start
    gap: number; // flex gap between columns (px)
    colPadH: number; // per-column horizontal padding (px) — flex-basis 0 distributes the
    // CONTENT box, so border-box px must be reduced by this to map to weights exactly.
    weightTotal: number; // sum of all column weights at drag start
  } | null>(null);
  // Direct DOM refs; colElRefs is only used to snapshot widths at drag start.
  const columnsRef = useRef<HTMLDivElement | null>(null);
  const colElRefs = useRef<(HTMLDivElement | null)[]>([]);
  const pctElRefs = useRef<(HTMLDivElement | null)[]>([]);
  const localColsRef = useRef<string[]>(cols);
  const localWidthsRef = useRef<number[]>(widths);
  localColsRef.current = localCols;
  localWidthsRef.current = localWidths;

  useEffect(() => { setLocalCols(cols); }, [cols]);
  useEffect(() => {
    // Guard against a malformed widths prop (e.g. nulls from the node) so a bad value
    // never collapses the columns.
    const valid = Array.isArray(widths) ? widths.map((x) => (Number.isFinite(x) && x > 0 ? x : 1)) : [];
    if (valid.length > 0) setLocalWidths(valid);
  }, [widths]);

  const apply = useCallback((next: string[], w?: number[]) => {
    setLocalCols(next);
    onChange?.(next);
    if (w) onWidthsChange?.(w);
  }, [onChange, onWidthsChange]);

  const handleSerialize = useCallback((key: string, json: string) => {
    const idx = Number(key);
    if (idx >= 0 && idx < localColsRef.current.length) {
      const next = localColsRef.current.slice();
      next[idx] = json;
      apply(next);
    }
  }, [apply]);

  const addColumn = useCallback(() => {
    if (localColsRef.current.length >= MAX_COLS) return;
    const next = localColsRef.current.slice();
    next.push(EMPTY_COLUMN_JSON);
    apply(next, localWidthsRef.current.slice());
  }, [apply]);

  const removeColumn = useCallback((idx: number) => {
    if (localColsRef.current.length <= MIN_COLS) return;
    const next = localColsRef.current.slice();
    next.splice(idx, 1);
    const w = colWidths(localWidthsRef.current, localColsRef.current.length);
    w.splice(idx, 1);
    apply(next, w);
  }, [apply]);

  // Update the per-column share badges (top-right %). Reads the live pixel widths from
  // `dragWidthsRef` (the single source of truth during a drag) so it's always current
  // and doesn't depend on DOM read timing. No-op when not dragging (no badges).
  const updatePctBadges = useCallback(() => {
    const pxs = dragWidthsRef.current;
    if (!pxs) return;
    const total = pxs.reduce((a, b) => a + b, 0) || 1;
    for (let i = 0; i < pxs.length; i++) {
      const el = pctElRefs.current[i];
      if (el && pxs[i]) el.textContent = `${Math.round((pxs[i] / total) * 100)}%`;
    }
  }, []);

  // Drag a divider to move the boundary between the two columns it separates. Only the
  // two columns it separates change: the left column's pixel width is driven by the
  // cursor delta (no snap — uses the press point), the right column takes the rest of
  // the pair's combined width. Everything is applied via React state (`dragWidths`),
  // so the DOM and React never disagree.
  const onDrag = useCallback((e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (d.idx + 1 >= localColsRef.current.length) return;
    const base = dragWidthsRef.current;
    if (!base) return;
    const curX = e.clientX;
    const minPx = 48;
    let leftPx = d.startLeftPx + (curX - d.startX);
    const maxLeft = d.pairPx - d.gap - minPx;
    leftPx = Math.max(minPx, Math.min(maxLeft, leftPx));
    const pxs = base.slice();
    pxs[d.idx] = leftPx;
    pxs[d.idx + 1] = d.pairPx - d.gap - leftPx;
    dragWidthsRef.current = pxs;
    setDragWidths(pxs);
    updatePctBadges();
  }, [updatePctBadges]);

  const endDrag = useCallback((e: PointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    document.body.style.cursor = "";
    document.removeEventListener("pointermove", onDrag);
    document.removeEventListener("pointerup", endDrag);
    // Release pointer capture if we grabbed it.
    try {
      const el = colElRefs.current[d?.idx ?? -1];
      if (el && el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (!d) return;
    // Convert the final pixel widths (from the drag) back to flex-grow weights so that
    // flex re-layout reproduces the EXACT same border-box widths (zero drift). The
    // columns are `flex: w 1 0` = basis 0, so flex distributes the CONTENT box; the
    // border-box = (weight/weightTotal)*F + colPadH, where F = total content space =
    // sum(border-box) - n*colPadH. Solve weight_i = ((borderBox_i - colPadH)/F)*weightTotal.
    const pxs = dragWidthsRef.current ?? colWidths(localWidthsRef.current, localColsRef.current.length);
    const n = pxs.length;
    const F = Math.max(1, pxs.reduce((a, b) => a + b, 0) - n * d.colPadH);
    const weightTotal = d.weightTotal > 0 ? d.weightTotal : 1;
    const contentOf = (px: number) => Math.max(1, px - d.colPadH);
    const leftW = (contentOf(pxs[d.idx]) / F) * weightTotal;
    const rightW = (contentOf(pxs[d.idx + 1]) / F) * weightTotal;
    const cur = colWidths(localWidthsRef.current, n);
    const next = cur.map((x) => (Number.isFinite(x) && x > 0 ? x : 1));
    next[d.idx] = Math.round(Math.max(MIN_W, leftW) * 100) / 100;
    next[d.idx + 1] = Math.round(Math.max(MIN_W, rightW) * 100) / 100;
    localWidthsRef.current = next;
    dragWidthsRef.current = null;
    setDragWidths(null);
    setLocalWidths(next);
    onWidthsChange?.(next);
  }, [onDrag, onWidthsChange]);

  const startDrag = useCallback((idx: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    const rowEl = columnsRef.current;
    if (!rowEl) return;
    const leftCol = colElRefs.current[idx];
    const rightCol = colElRefs.current[idx + 1];
    if (!leftCol || !rightCol) return;
    const lr = leftCol.getBoundingClientRect();
    const rr = rightCol.getBoundingClientRect();
    // Gap between the two columns (flex gap).
    const gap = Math.max(0, rr.left - lr.right);
    const n = localColsRef.current.length;
    // Per-column horizontal padding (the columns are `flex: w 1 0` = basis 0, so flex
    // distributes the CONTENT box; border-box px must be reduced by this to map to a
    // weight that renders the exact same border-box width at release).
    const cs = rowEl.ownerDocument.defaultView?.getComputedStyle(leftCol);
    const colPadH =
      (parseFloat(cs?.paddingLeft ?? "0") || 0) + (parseFloat(cs?.paddingRight ?? "0") || 0);
    // Snapshot every column's current pixel width so non-dragged columns keep their
    // exact width (only the pair rebalances).
    const pxs: number[] = new Array(n);
    for (let i = 0; i < n; i++) pxs[i] = colElRefs.current[i]?.getBoundingClientRect().width ?? 0;
    const curWeights = colWidths(localWidthsRef.current, n);
    dragWidthsRef.current = pxs;
    setDragWidths(pxs);
    dragRef.current = {
      idx,
      startX: e.clientX,
      startLeftPx: lr.width,
      pairPx: lr.width + gap + rr.width,
      pairWeight: (curWeights[idx] ?? 1) + (curWeights[idx + 1] ?? 1),
      gap: gap || 0,
      colPadH: colPadH || 0,
      weightTotal: curWeights.reduce((a, b) => a + b, 0) || 1,
    };
    // Grab pointer capture on the divider so we keep receiving pointermove even if
    // the cursor leaves the thin handle — makes the drag reliable and smooth.
    try {
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    } catch {
      /* ignore */
    }
    // Fill the share badges once the drag widths have been applied (next frame).
    requestAnimationFrame(() => updatePctBadges());
    // During the drag show a full-window resize cursor so the gesture reads clearly.
    document.body.style.cursor = "col-resize";
    document.addEventListener("pointermove", onDrag);
    document.addEventListener("pointerup", endDrag);
  }, [onDrag, endDrag, updatePctBadges]);

  return (
    <div className={`editor-columns${dragWidths !== null ? " is-dragging" : ""}`} data-count={String(localCols.length)} ref={columnsRef}>
      {localCols.map((c, i) => {
        const w = shareWeight(localWidths, i, localCols.length);
        // Single source of truth: while dragWidths is set, columns are laid out by
        // exact pixel widths; otherwise by flex-grow weights. React owns both, so the
        // DOM and React never disagree (no jump on re-render).
        const isDrag = dragWidths !== null;
        const style = isDrag
          ? { flex: "none", width: `${dragWidths![i]}px` }
          : { flex: `${w} 1 0` };
        return (
          <div
            key={`col-${i}`}
            className="editor-column"
            style={style}
            ref={(el) => { colElRefs.current[i] = el; }}
          >
            {dragWidths !== null && (
              <div
                className="editor-column-pct"
                ref={(el) => { pctElRefs.current[i] = el; }}
              ></div>
            )}
            {i < localCols.length - 1 && (
              <div className="editor-column-divider" onPointerDown={startDrag(i)} title="拖拽调整列宽" />
            )}
            <div className="editor-column-actions">
              {i === localCols.length - 1 && localCols.length < MAX_COLS && (
                <button className="editor-column-add" title="在右侧添加一列" onClick={addColumn}>＋</button>
              )}
              {localCols.length > MIN_COLS && (
                <button className="editor-column-remove" title="删除此列" onClick={() => removeColumn(i)}>×</button>
              )}
            </div>
            <ColumnEditor
              columnKey={String(i)}
              column={c}
              pageId={pageId}
              onSerialize={handleSerialize}
            />
          </div>
        );
      })}
    </div>
  );
}
