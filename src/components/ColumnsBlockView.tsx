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
  const dragRef = useRef<{
    idx: number;
    startX: number;
    // The divider sits on the boundary between col idx (left) and idx+1 (right). We
    // drive the divider's PIXEL x so it lands exactly under the cursor: set the left
    // column's width to (cursor - columnContentLeft) and let the right column fill
    // the remainder. On release we convert these pixel widths back to flex-grow
    // weights for persistence.
    contentLeft: number; // container content box left (where the row's columns start)
    contentRight: number; // container content box right
    gap: number; // flex gap between columns (px)
    // Final pixel widths captured at release, converted to weights in endDrag.
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

  // Drag a divider to move the boundary between the two columns it separates. We set
  // the LEFT column's width directly in PIXELS so the divider lands exactly under the
  // cursor (真跟手), and the right column flex-fills the rest. We apply synchronously
  // (not deferred to rAF) so there's no extra frame of latency.
  const onDrag = useCallback((e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (d.idx + 1 >= d.w.length) return; // last column has no divider
    const curX = e.clientX;
    const minPx = 48;
    // The divider is centered in the gap (gap/2 beyond the column's right edge), so
    // the left column's right edge must sit gap/2 BEFORE the cursor for the divider
    // center to land under it.
    let leftPx = curX - d.contentLeft - d.gap / 2;
    const maxLeft = d.contentRight - d.contentLeft - d.gap - minPx;
    leftPx = Math.max(minPx, Math.min(maxLeft, leftPx));
    d.leftPx = leftPx;
    d.rightPx = d.contentRight - d.contentLeft - d.gap - leftPx;
    // Apply pixel widths directly for a 1:1 divider-to-cursor mapping.
    const leftEl = colElRefs.current[d.idx];
    const rightEl = colElRefs.current[d.idx + 1];
    if (leftEl) {
      leftEl.style.flex = "none";
      leftEl.style.width = `${leftPx}px`;
    }
    if (rightEl) {
      rightEl.style.flex = "1 1 0";
      rightEl.style.width = "";
    }
  }, []);

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
    const rowRect = rowEl.getBoundingClientRect();
    const c0 = colElRefs.current[0];
    const leftCol = colElRefs.current[idx];
    const rightCol = colElRefs.current[idx + 1];
    const cs = rowEl.ownerDocument.defaultView?.getComputedStyle(rowEl);
    const padL = parseFloat(cs?.paddingLeft ?? "0") || 0;
    const padR = parseFloat(cs?.paddingRight ?? "0") || 0;
    // Container content box (columns start here). The row has its own padding.
    const contentLeft = rowRect.left + padL;
    const contentRight = rowRect.right - padR;
    // Gap between adjacent columns (flex gap).
    const gap =
      c0 && leftCol && rightCol
        ? Math.max(0, rightCol.getBoundingClientRect().left - leftCol.getBoundingClientRect().right)
        : 0;
    const n = localColsRef.current.length;
    const w = colWidths(localWidthsRef.current, n);
    dragRef.current = {
      idx,
      startX: e.clientX,
      contentLeft,
      contentRight,
      gap: gap || 0,
      leftPx: leftCol ? leftCol.getBoundingClientRect().width : 0,
      rightPx: rightCol ? rightCol.getBoundingClientRect().width : 0,
      w,
    };
    // Grab pointer capture on the divider so we keep receiving pointermove even if
    // the cursor leaves the thin handle — makes the drag reliable and smooth.
    try {
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    } catch {
      /* ignore */
    }
    // During the drag show a full-window resize cursor so the gesture reads clearly.
    document.body.style.cursor = "col-resize";
    document.addEventListener("pointermove", onDrag);
    document.addEventListener("pointerup", endDrag);
  }, [onDrag, endDrag]);

  return (
    <div className="editor-columns" data-count={String(localCols.length)} ref={columnsRef}>
      {localCols.map((c, i) => {
        const w = shareWeight(localWidths, i, localCols.length);
        return (
          <div
            key={`col-${i}`}
            className="editor-column"
            style={{ flex: `${w} 1 0` }}
            ref={(el) => { colElRefs.current[i] = el; }}
          >
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
