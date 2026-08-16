import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getNodeByKey, $getSelection, $isRangeSelection } from "lexical";
import {
  $findCellNode,
  $getTableNodeFromLexicalNodeOrThrow,
  type TableCellNode,
  type TableNode,
  type TableRowNode,
} from "@lexical/table";

// Column resize handles rendered at every internal column boundary of the
// table header row. Dragging a handle transfers width between the two adjacent
// columns (total width stays constant, so the full-width table tracks the
// pointer 1:1).

const MIN_WIDTH = 60;

interface Handle {
  colIndex: number;
  left: number;
  top: number;
  height: number;
}

interface ResizeState {
  startX: number;
  tableKey: string;
  colIndex: number;
  renderWidths: number[];
}

export function TableResizerPlugin() {
  const [editor] = useLexicalComposerContext();
  const [handles, setHandles] = useState<Handle[]>([]);
  const resizeRef = useRef<ResizeState | null>(null);

  const refresh = useCallback(() => {
    editor.getEditorState().read(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) {
        setHandles([]);
        return;
      }
      const cell = $findCellNode(selection.anchor.getNode());
      if (!cell) {
        setHandles([]);
        return;
      }
      const table = $getTableNodeFromLexicalNodeOrThrow(cell);
      const firstRow = table.getFirstChild<TableRowNode>();
      const cells = firstRow?.getChildren<TableCellNode>() ?? [];
      const next: Handle[] = [];
      for (let i = 0; i < cells.length - 1; i++) {
        const dom = editor.getElementByKey(cells[i].getKey());
        if (!dom) continue;
        const rect = dom.getBoundingClientRect();
        next.push({ colIndex: i, left: rect.right - 2, top: rect.top, height: rect.height });
      }
      setHandles(next);
    });
  }, [editor]);

  useEffect(() => {
    const unregister = editor.registerUpdateListener(() => refresh());
    const onScroll = () => refresh();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      unregister();
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [editor, refresh]);

  const startResize = (e: ReactMouseEvent, colIndex: number) => {
    e.preventDefault();
    e.stopPropagation();
    editor.getEditorState().read(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return;
      const cell = $findCellNode(selection.anchor.getNode());
      if (!cell) return;
      const table = $getTableNodeFromLexicalNodeOrThrow(cell);
      const cells = table.getFirstChild<TableRowNode>()?.getChildren<TableCellNode>() ?? [];
      if (!cells[colIndex] || !cells[colIndex + 1]) return;
      const renderWidths = cells.map((c) => {
        const dom = editor.getElementByKey(c.getKey());
        return dom ? dom.getBoundingClientRect().width : 75;
      });
      resizeRef.current = { startX: e.clientX, tableKey: table.getKey(), colIndex, renderWidths };
    });

    const onMove = (ev: MouseEvent) => {
      const r = resizeRef.current;
      if (!r) return;
      const left = r.renderWidths[r.colIndex];
      const right = r.renderWidths[r.colIndex + 1];
      const delta = Math.max(MIN_WIDTH - left, Math.min(right - MIN_WIDTH, ev.clientX - r.startX));
      editor.update(() => {
        const table = $getNodeByKey(r.tableKey);
        if (table) resizeColumn(table as TableNode, r.colIndex, r.renderWidths, delta);
      });
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("mouseup", onUp, true);
      resizeRef.current = null;
    };
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("mouseup", onUp, true);
  };

  return (
    <>
      {handles.map((h) => (
        <div
          key={h.colIndex}
          className="table-resize-handle"
          style={{ top: h.top, left: h.left, height: h.height }}
          title="拖动调整列宽"
          onMouseDown={(e) => startResize(e, h.colIndex)}
        />
      ))}
    </>
  );
}

function resizeColumn(table: TableNode, colIndex: number, base: number[], delta: number) {
  const columnCount = table.getColumnCount();
  if (colIndex < 0 || colIndex + 1 >= columnCount || base.length <= colIndex + 1) return;
  const next = base.slice(0, columnCount);
  next[colIndex] = base[colIndex] + delta;
  next[colIndex + 1] = base[colIndex + 1] - delta;
  table.setColWidths(next);
}
