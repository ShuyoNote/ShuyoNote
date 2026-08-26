import { useCallback, useEffect, useRef, useState } from "react";
import { ColumnEditor } from "./ColumnEditor";
import { EMPTY_COLUMN_JSON } from "../editor/nodes/ColumnsBlockNode";

// Route B: renders N independent column editors in a flex row. Each column owns its
// own EditorState (JSON). Local state mirrors the cols prop so structural changes
// (add/remove) reflect immediately; each change is pushed up via onChange. Optional
// per-column widths are adjustable by dragging the divider (flex-grow weights).

const MIN_COLS = 1;
const MAX_COLS = 4;
const MIN_PCT = 20; // a column's width share can't go below 20%

function shareWeight(widths: number[], idx: number, total: number): number {
  if (widths.length === total) return widths[idx] ?? 100 / total;
  return 100 / total;
}

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
  const [localCols, setLocalCols] = useState<string[]>(cols);
  const [localWidths, setLocalWidths] = useState<number[]>(widths);
  const dragRef = useRef<{ idx: number; startX: number; startPct: number; trackW: number } | null>(null);
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
    const w = localWidthsRef.current.slice();
    if (w.length >= localColsRef.current.length) w.splice(idx, 1);
    apply(next, w.length === next.length ? w : []);
  }, [apply]);

  // Drag a divider to resize the LEFT column at idx; its share (pct) grows/shrinks,
  // and the last column absorbs the remainder so widths stay ~100.
  const onDrag = useCallback((e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const deltaPct = ((e.clientX - d.startX) / Math.max(d.trackW, 1)) * 100;
    const newPct = Math.max(MIN_PCT, Math.min(100 - MIN_PCT, d.startPct + deltaPct));
    const n = localColsRef.current.length;
    const base = Array.from({ length: n }, (_, i) => shareWeight(localWidthsRef.current, i, n));
    const next = base.slice();
    next[d.idx] = newPct;
    const othersSum = next.reduce((a, b) => a + b, 0) - newPct;
    const lastIdx = n - 1;
    if (lastIdx !== d.idx) next[lastIdx] = Math.max(MIN_PCT, 100 - othersSum);
    // Normalize to sum 100.
    const sum = next.reduce((a, b) => a + b, 0);
    const norm = next.map((v) => (v / sum) * 100);
    setLocalWidths(norm);
    onWidthsChange?.(norm);
  }, [onWidthsChange]);

  const endDrag = useCallback(() => {
    dragRef.current = null;
    document.removeEventListener("pointermove", onDrag);
    document.removeEventListener("pointerup", endDrag);
  }, [onDrag]);

  const startDrag = useCallback((idx: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    const container = (e.currentTarget as HTMLElement).closest(".editor-columns") as HTMLElement | null;
    const trackW = container ? container.getBoundingClientRect().width : 640;
    dragRef.current = { idx, startX: e.clientX, startPct: shareWeight(localWidthsRef.current, idx, localColsRef.current.length), trackW };
    document.addEventListener("pointermove", onDrag);
    document.addEventListener("pointerup", endDrag);
  }, [onDrag, endDrag]);

  return (
    <div className="editor-columns" data-count={String(localCols.length)}>
      {localCols.map((c, i) => {
        const pct = shareWeight(localWidths, i, localCols.length);
        return (
          <div key={`col-${i}`} className="editor-column" style={{ width: `${pct}%`, flex: `0 0 ${pct}%` }}>
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
