import { useEffect, useRef, useState } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $isElementNode } from "lexical";
import {
  $deleteTableColumnAtSelection,
  $deleteTableRowAtSelection,
  $insertTableColumnAtNode,
  $insertTableRowAtNode,
  $setTableColumnIsHeader,
  $setTableRowIsHeader,
} from "@lexical/table";
import {
  AlignCenterIcon,
  AlignLeftIcon,
  AlignRightIcon,
  DeleteColumnIcon,
  DeleteRowIcon,
  FillIcon,
  HeaderColumnIcon,
  HeaderRowIcon,
  InsertColumnLeftIcon,
  InsertColumnRightIcon,
  InsertRowAboveIcon,
  InsertRowBelowIcon,
} from "../../components/icons";
import {
  $getActiveTableContext,
  $isHeaderColumn,
  $isHeaderRow,
  $setCellsAlign,
  $setCellsBackground,
} from "./tableHelpers";

// Wolai-style floating table toolbar. Appears above the table when the caret is
// inside a cell or a row/column/cell range is selected, offering insert/delete,
// header toggles, alignment and background color.

const PALETTE: (string | null)[] = [
  null,
  "#f1f3f5",
  "#ffd6d6",
  "#ffe3c2",
  "#fff3bf",
  "#d3f9d8",
  "#d0ebff",
  "#e5dbff",
  "#f8d3f0",
];

interface MenuState {
  top: number;
  left: number;
  isHeaderRow: boolean;
  isHeaderCol: boolean;
  align: "left" | "center" | "right";
  bg: string | null;
}

type Align = MenuState["align"];

export function TableMenuPlugin() {
  const [editor] = useLexicalComposerContext();
  const [state, setState] = useState<MenuState | null>(null);
  const [showPalette, setShowPalette] = useState(false);
  const paletteRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    return editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        const ctx = $getActiveTableContext();
        if (!ctx) {
          setState(null);
          setShowPalette(false);
          return;
        }
        const dom = editor.getElementByKey(ctx.table.getKey());
        if (!dom) {
          setState(null);
          return;
        }
        const rect = dom.getBoundingClientRect();
        const firstChild = ctx.cell.getFirstChild();
        const format = $isElementNode(firstChild) ? firstChild.getFormatType() : "";
        const align: Align = format === "center" ? "center" : format === "right" ? "right" : "left";
        setState({
          top: rect.top - 40,
          left: rect.left,
          isHeaderRow: $isHeaderRow(ctx.table),
          isHeaderCol: $isHeaderColumn(ctx.table),
          align,
          bg: ctx.cell.getBackgroundColor(),
        });
      });
    });
  }, [editor]);

  // Close the palette on outside click / Escape.
  useEffect(() => {
    if (!showPalette) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      const el = t as Element | null;
      if (
        paletteRef.current &&
        !paletteRef.current.contains(t) &&
        !el?.closest?.(".table-menu")
      ) {
        setShowPalette(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowPalette(false);
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [showPalette]);

  if (!state) return null;

  const run = (fn: () => void) => editor.update(() => fn());

  const insertRow = (after: boolean) =>
    run(() => {
      const ctx = $getActiveTableContext();
      if (ctx) $insertTableRowAtNode(ctx.cell, after);
    });
  const insertCol = (after: boolean) =>
    run(() => {
      const ctx = $getActiveTableContext();
      if (ctx) $insertTableColumnAtNode(ctx.cell, after);
    });
  const toggleHeaderRow = () =>
    run(() => {
      const ctx = $getActiveTableContext();
      if (ctx) $setTableRowIsHeader(ctx.table, 0, !$isHeaderRow(ctx.table));
    });
  const toggleHeaderCol = () =>
    run(() => {
      const ctx = $getActiveTableContext();
      if (ctx) $setTableColumnIsHeader(ctx.table, 0, !$isHeaderColumn(ctx.table));
    });
  const align = (a: Align) => run(() => $setCellsAlign(a));
  const setBg = (color: string | null) => {
    run(() => $setCellsBackground(color));
    setShowPalette(false);
  };

  return (
    <>
      <div className="table-menu" style={{ top: state.top, left: state.left }}>
        <button title="上方插入行" onMouseDown={(e) => e.preventDefault()} onClick={() => insertRow(false)}>
          <InsertRowAboveIcon />
        </button>
        <button title="下方插入行" onMouseDown={(e) => e.preventDefault()} onClick={() => insertRow(true)}>
          <InsertRowBelowIcon />
        </button>
        <span className="table-menu-sep" />
        <button title="左侧插入列" onMouseDown={(e) => e.preventDefault()} onClick={() => insertCol(false)}>
          <InsertColumnLeftIcon />
        </button>
        <button title="右侧插入列" onMouseDown={(e) => e.preventDefault()} onClick={() => insertCol(true)}>
          <InsertColumnRightIcon />
        </button>
        <span className="table-menu-sep" />
        <button
          title="表头行"
          className={state.isHeaderRow ? "active" : ""}
          onMouseDown={(e) => e.preventDefault()}
          onClick={toggleHeaderRow}
        >
          <HeaderRowIcon />
        </button>
        <button
          title="表头列"
          className={state.isHeaderCol ? "active" : ""}
          onMouseDown={(e) => e.preventDefault()}
          onClick={toggleHeaderCol}
        >
          <HeaderColumnIcon />
        </button>
        <span className="table-menu-sep" />
        <button
          title="左对齐"
          className={state.align === "left" ? "active" : ""}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => align("left")}
        >
          <AlignLeftIcon />
        </button>
        <button
          title="居中对齐"
          className={state.align === "center" ? "active" : ""}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => align("center")}
        >
          <AlignCenterIcon />
        </button>
        <button
          title="右对齐"
          className={state.align === "right" ? "active" : ""}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => align("right")}
        >
          <AlignRightIcon />
        </button>
        <span className="table-menu-sep" />
        <button
          title="背景色"
          className={showPalette ? "active" : ""}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setShowPalette((v) => !v)}
        >
          <FillIcon />
          <span className="table-menu-swatch" style={{ background: state.bg ?? "transparent" }} />
        </button>
        <span className="table-menu-sep" />
        <button
          title="删除行"
          className="danger"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => run(() => $deleteTableRowAtSelection())}
        >
          <DeleteRowIcon />
        </button>
        <button
          title="删除列"
          className="danger"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => run(() => $deleteTableColumnAtSelection())}
        >
          <DeleteColumnIcon />
        </button>
      </div>

      {showPalette && (
        <div className="table-palette" ref={paletteRef} style={{ top: state.top + 34, left: state.left }}>
          {PALETTE.map((color, i) => (
            <button
              key={i}
              className={state.bg === color ? "picked" : ""}
              style={color ? { background: color } : undefined}
              title={color ? "设置背景色" : "清除背景色"}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setBg(color)}
            >
              {color === null && <span className="palette-clear" />}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
