import { useCallback, useEffect, useState } from "react";
import { ColumnEditor } from "./ColumnEditor";
import { EMPTY_COLUMN_JSON } from "../editor/nodes/ColumnsBlockNode";

// Route B: renders N independent column editors in a flex row. Each column owns its
// own EditorState (JSON). Local state mirrors the cols prop so structural changes
// (add/remove) reflect immediately; each change is also pushed up via onChange so
// the parent ColumnsNode persists it.

const MIN_COLS = 1;
const MAX_COLS = 4;

export function ColumnsBlockView({
  cols,
  pageId,
  onChange,
}: {
  cols: string[]; // one serialized EditorState JSON per column
  pageId: string;
  onChange?: (cols: string[]) => void;
}) {
  const [localCols, setLocalCols] = useState<string[]>(cols);
  // Sync when the external cols change (e.g. different column count from props).
  useEffect(() => {
    setLocalCols(cols);
  }, [cols]);

  const apply = useCallback((next: string[]) => {
    setLocalCols(next);
    onChange?.(next);
  }, [onChange]);

  const handleSerialize = useCallback((key: string, json: string) => {
    const idx = Number(key);
    if (idx >= 0 && idx < localCols.length) {
      const next = localCols.slice();
      next[idx] = json;
      apply(next);
    }
  }, [localCols, apply]);

  const addColumn = useCallback(() => {
    if (localCols.length >= MAX_COLS) return;
    const next = localCols.slice();
    next.push(EMPTY_COLUMN_JSON);
    apply(next);
  }, [localCols, apply]);

  const removeColumn = useCallback((idx: number) => {
    if (localCols.length <= MIN_COLS) return;
    const next = localCols.slice();
    next.splice(idx, 1);
    apply(next);
  }, [localCols, apply]);

  return (
    <div className="editor-columns" data-count={String(localCols.length)}>
      {localCols.map((c, i) => (
        <div key={`col-${i}`} className="editor-column-row">
          <ColumnEditor
            columnKey={String(i)}
            column={c}
            pageId={pageId}
            onSerialize={handleSerialize}
          />
          <div className="editor-column-actions">
            {i === localCols.length - 1 && localCols.length < MAX_COLS && (
              <button className="editor-column-add" title="在右侧添加一列" onClick={addColumn}>＋</button>
            )}
            {localCols.length > MIN_COLS && (
              <button className="editor-column-remove" title="删除此列" onClick={() => removeColumn(i)}>×</button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
