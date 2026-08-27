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
  // While a divider is being dragged, each column's top-right shows its current
  // share (percentage). We set this once on drag-start/end (cheap) and update the
  // badge text via direct DOM during the drag (no re-render per move).
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{
    idx: number;
    startX: number;
    // Dragging ONLY rebalances the two columns the divider separates. We preserve the
    // pair's combined pixel width (incl. the gap between them) so the other columns
    // don't move; the left column grows and the right shrinks by the same amount.
    pairLeft: number; // left column's content-left x on the page at drag start
    pairPx: number; // combined width of the two columns, incl. the gap between them
    gap: number; // flex gap between columns (px)
    leftPx: number;
    rightPx: number;
    // Weights across the whole row, reused; [idx]/[idx+1] are updated on release.
    w: number[];
  } | null>(null);
  // Direct DOM refs so a drag can move the divider WITHOUT a React re-render (the
  // nested column editors are heavy; re-rendering them every pointermove is what
  // made dragging feel sluggish).
  const columnsRef = useRef<HTMLDivElement | null>(null);
  const colElRefs = useRef<(HTMLDivElement | null)[]>([]);
  const pctElRefs = useRef<(HTMLDivElement | null)[]>([]);
  const localColsRef = useRef<string[]>(cols);
  const localWidthsRef = useRef<number[]>(widths);
  localColsRef.current = localCols;
  localWidthsRef.current = localWidths;

  useEffect(() => { setLocalCols(cols); }, [cols]);
  useEffect(() => { setLocalWidths(widths); }, [widths]);

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

  // Update the per-column share badges (top-right %) from the live drag widths,
  // writing directly to their DOM so no React re-render happens per pointermove.
  const updatePctBadges = useCallback((d: NonNullable<typeof dragRef.current>) => {
    const n = d.w.length;
    // Convert the dragged pair's pixels back to weights using the same mapping as
    // endDrag, so the badge reflects the final persisted share.
    const pairPx = Math.max(1, d.leftPx + d.rightPx);
    const pairWeight = d.w[d.idx] + d.w[d.idx + 1];
    const weights = d.w.slice();
    if (d.idx + 1 < n) {
      weights[d.idx] = Math.max(MIN_W, (d.leftPx / pairPx) * pairWeight);
      weights[d.idx + 1] = Math.max(MIN_W, pairWeight - weights[d.idx]);
    }
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    for (let i = 0; i < n; i++) {
      const el = pctElRefs.current[i];
      if (el) el.textContent = `${Math.round((weights[i] / total) * 100)}%`;
    }
  }, []);

  // Drag a divider to move the boundary between the two columns it separates. Only
  // those two columns change: the left column's pixel width is driven by the cursor
  // (the divider center lands under it), and the right column takes the remainder of
  // the pair's combined width — so the OTHER columns stay exactly where they were.
  // Applied synchronously (no rAF) and via direct DOM (no React re-render).
  const onDrag = useCallback((e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (d.idx + 1 >= d.w.length) return; // last column has no divider
    const curX = e.clientX;
    const minPx = 48;
    // Divider center = left column's right edge + gap/2. So the left column width =
    // cursor - left column's left edge - gap/2.
    let leftPx = curX - d.pairLeft - d.gap / 2;
    // Clamp so the left column keeps a min width and the right column keeps a min too
    // (it gets pairPx - gap - leftPx).
    const maxLeft = d.pairPx - d.gap - minPx;
    leftPx = Math.max(minPx, Math.min(maxLeft, leftPx));
    d.leftPx = leftPx;
    d.rightPx = d.pairPx - d.gap - leftPx;
    // Apply fixed pixel widths to ONLY the two columns; leave the rest untouched.
    const leftEl = colElRefs.current[d.idx];
    const rightEl = colElRefs.current[d.idx + 1];
    if (leftEl) {
      leftEl.style.flex = "none";
      leftEl.style.width = `${leftPx}px`;
    }
    if (rightEl) {
      rightEl.style.flex = "none";
      rightEl.style.width = `${d.rightPx}px`;
    }
    updatePctBadges(d);
  }, [updatePctBadges]);

  const endDrag = useCallback((e: PointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    setDragging(false);
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
    // Clear the ad-hoc pixel style, convert back to flex-grow weights, and persist.
    const leftEl = colElRefs.current[d.idx];
    const rightEl = colElRefs.current[d.idx + 1];
    if (leftEl) { leftEl.style.width = ""; leftEl.style.flex = ""; }
    if (rightEl) { rightEl.style.width = ""; rightEl.style.flex = ""; }
    // Pixel widths -> weights: map the pair's pixel space onto its weight total, so
    // the other columns keep their relative share.
    const pairPx = Math.max(1, d.leftPx + d.rightPx);
    const pairWeight = d.w[d.idx] + d.w[d.idx + 1];
    const leftW = Math.max(MIN_W, (d.leftPx / pairPx) * pairWeight);
    const rightW = Math.max(MIN_W, pairWeight - leftW);
    d.w[d.idx] = Math.round(leftW * 100) / 100;
    d.w[d.idx + 1] = Math.round(rightW * 100) / 100;
    localWidthsRef.current = d.w;
    const final = d.w.slice();
    setLocalWidths(final);
    onWidthsChange?.(final);
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
    const w = colWidths(localWidthsRef.current, n);
    dragRef.current = {
      idx,
      startX: e.clientX,
      pairLeft: lr.left,
      pairPx: lr.width + gap + rr.width,
      gap: gap || 0,
      leftPx: lr.width,
      rightPx: rr.width,
      w,
    };
    // Grab pointer capture on the divider so we keep receiving pointermove even if
    // the cursor leaves the thin handle — makes the drag reliable and smooth.
    try {
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    } catch {
      /* ignore */
    }
    // Show the per-column share badges for the duration of the drag. The initial
    // fill is deferred to the next animation frame so the freshly-rendered badge
    // nodes are mounted before we write their text.
    setDragging(true);
    requestAnimationFrame(() => {
      if (dragRef.current) updatePctBadges(dragRef.current);
    });
    // During the drag show a full-window resize cursor so the gesture reads clearly.
    document.body.style.cursor = "col-resize";
    document.addEventListener("pointermove", onDrag);
    document.addEventListener("pointerup", endDrag);
  }, [onDrag, endDrag, updatePctBadges]);

  return (
    <div className={`editor-columns${dragging ? " is-dragging" : ""}`} data-count={String(localCols.length)} ref={columnsRef}>
      {localCols.map((c, i) => {
        const w = shareWeight(localWidths, i, localCols.length);
        return (
          <div
            key={`col-${i}`}
            className="editor-column"
            style={{ flex: `${w} 1 0` }}
            ref={(el) => { colElRefs.current[i] = el; }}
          >
            {dragging && (
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
