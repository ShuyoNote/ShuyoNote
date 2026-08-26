import { useCallback, useRef } from "react";
import { ColumnEditor } from "./ColumnEditor";

// Route B: renders N independent column editors in a flex row. Each column owns its
// own EditorState (JSON). On column edit, we update the local `cols` array and call
// `onChange(cols)` so the parent ColumnsNode persists the aggregated state.

export function ColumnsBlockView({
  cols,
  pageId,
  onChange,
}: {
  cols: string[]; // one serialized EditorState JSON per column
  pageId: string;
  onChange?: (cols: string[]) => void;
}) {
  const colsRef = useRef<string[]>(cols);
  colsRef.current = cols;

  const handleSerialize = useCallback((key: string, json: string) => {
    const idx = Number(key);
    const next = colsRef.current.slice();
    // Guard against out-of-range writes (column removed between render and change).
    if (idx >= 0 && idx < next.length) {
      next[idx] = json;
      onChange?.(next);
    }
  }, [onChange]);

  return (
    <div className="editor-columns" data-count={String(cols.length)}>
      {cols.map((c, i) => (
        <ColumnEditor
          key={`col-${i}`}
          columnKey={String(i)}
          column={c}
          pageId={pageId}
          onSerialize={handleSerialize}
        />
      ))}
    </div>
  );
}
