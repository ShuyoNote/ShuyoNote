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
    left: number; // left column weight at drag start
    right: number; // right column weight at drag start
    pair: number; // left + right (kept constant)
    trackW: number;
    w: number[]; // the working weights buffer, reused across the drag
  } | null>(null);
  // requestAnimationFrame id for coalescing pointermove DOM writes: high-polling-rate
  // pointers can fire many moves per frame, so we only reflow the layout once per
  // frame regardless — a further speed-up over writing style.flex on every event.
  const rafRef = useRef<number | null>(null);
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

  // Drag a divider to move the boundary between the two columns it separates. The
  // cursor delta is mapped 1:1 to how much the left column grows (and the right
  // shrinks) in weight units, clamped so neither side can collapse. This keeps the
  // gesture feeling direct instead of the jumpy *4 from before.
  const onDrag = useCallback((e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (d.idx + 1 >= d.w.length) return; // last column has no divider
    const deltaFrac = (e.clientX - d.startX) / Math.max(d.trackW, 1);
    // deltaFrac in [-1,1] maps to ±pair weight — a full container-width drag moves
    // the whole pair, so it feels proportional and never overshoots.
    const left = Math.max(MIN_W, Math.min(d.pair - MIN_W, d.left + deltaFrac * d.pair));
    const right = d.pair - left;
    // Update the shared buffer (no per-move allocation).
    d.w[d.idx] = Math.round(left * 100) / 100;
    d.w[d.idx + 1] = Math.round(right * 100) / 100;
    localWidthsRef.current = d.w;
    // Coalesce: mark latest weights and flush to the DOM at most once per frame.
    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        const dd = dragRef.current;
        if (!dd) return;
        const leftEl = colElRefs.current[dd.idx];
        const rightEl = colElRefs.current[dd.idx + 1];
        if (leftEl) leftEl.style.flex = `${dd.w[dd.idx]} 1 0`;
        if (rightEl) rightEl.style.flex = `${dd.w[dd.idx + 1]} 1 0`;
      });
    }
  }, []);

  const endDrag = useCallback(() => {
    const d = dragRef.current;
    dragRef.current = null;
    document.body.style.cursor = "";
    document.removeEventListener("pointermove", onDrag);
    document.removeEventListener("pointerup", endDrag);
    // Flush any pending frame so the last position isn't dropped.
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (!d) return;
    // Write the final weights once, sync state (so rendered inline flex + localWidths
    // match), and commit to the editor node a single time.
    const leftEl = colElRefs.current[d.idx];
    const rightEl = colElRefs.current[d.idx + 1];
    if (leftEl) leftEl.style.flex = `${d.w[d.idx]} 1 0`;
    if (rightEl) rightEl.style.flex = `${d.w[d.idx + 1]} 1 0`;
    const final = d.w.slice();
    setLocalWidths(final);
    onWidthsChange?.(final);
  }, [onDrag, onWidthsChange]);

  const startDrag = useCallback((idx: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    const container = (e.currentTarget as HTMLElement).closest(".editor-columns") as HTMLElement | null;
    const trackW = container ? container.getBoundingClientRect().width : 640;
    const n = localColsRef.current.length;
    const w = colWidths(localWidthsRef.current, n);
    const left = w[idx];
    const right = w[idx + 1] ?? left;
    dragRef.current = { idx, startX: e.clientX, left, right, pair: left + right, trackW, w };
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
