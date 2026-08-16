import {
  $getNodeByKey,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $setSelection,
  type ElementFormatType,
} from "lexical";
import {
  $createTableSelectionFrom,
  $findCellNode,
  $getTableColumnIndexFromTableCellNode,
  $getTableNodeFromLexicalNodeOrThrow,
  $getTableRowIndexFromTableCellNode,
  $isTableCellNode,
  $isTableNode,
  $isTableSelection,
  TableCellHeaderStates,
  type TableCellNode,
  type TableNode,
  type TableRowNode,
} from "@lexical/table";

// Shared helpers for the Wolai-style table interaction plugins. All functions
// are meant to be called inside an editor read/update callback.

export interface TableContext {
  cell: TableCellNode;
  table: TableNode;
  rowIndex: number;
  colIndex: number;
}

// Resolve the "active" cell from the current selection (caret in a cell, or a
// table selection). Returns null when the selection is outside a table.
export function $getActiveTableContext(): TableContext | null {
  const selection = $getSelection();
  let cell: TableCellNode | null = null;
  if ($isRangeSelection(selection)) {
    cell = $findCellNode(selection.anchor.getNode());
  } else if ($isTableSelection(selection)) {
    const node = $getNodeByKey(selection.anchor.key);
    cell = $isTableCellNode(node) ? node : null;
  }
  if (!cell) return null;
  const table = $getTableNodeFromLexicalNodeOrThrow(cell);
  return {
    cell,
    table,
    rowIndex: $getTableRowIndexFromTableCellNode(cell),
    colIndex: $getTableColumnIndexFromTableCellNode(cell),
  };
}

// Cells an operation (background / alignment) should apply to: the selected
// cells when a table selection exists, otherwise the single active cell.
export function $getTargetCells(): TableCellNode[] {
  const selection = $getSelection();
  if ($isTableSelection(selection)) {
    return selection.getNodes().filter($isTableCellNode);
  }
  const ctx = $getActiveTableContext();
  return ctx ? [ctx.cell] : [];
}

export function $selectRow(tableKey: string, rowIndex: number) {
  const table = $getNodeByKey(tableKey);
  if (!$isTableNode(table)) return;
  const row = table.getChildren<TableRowNode>()[rowIndex];
  if (!row) return;
  const cells = row.getChildren<TableCellNode>();
  if (cells.length === 0) return;
  $setSelection($createTableSelectionFrom(table, cells[0], cells[cells.length - 1]));
}

export function $selectColumn(tableKey: string, colIndex: number) {
  const table = $getNodeByKey(tableKey);
  if (!$isTableNode(table)) return;
  const rows = table.getChildren<TableRowNode>();
  if (rows.length === 0) return;
  const first = rows[0].getChildren<TableCellNode>()[colIndex];
  const last = rows[rows.length - 1].getChildren<TableCellNode>()[colIndex];
  if (!first || !last) return;
  $setSelection($createTableSelectionFrom(table, first, last));
}

export function $setCellsBackground(color: string | null) {
  for (const cell of $getTargetCells()) cell.setBackgroundColor(color);
}

export function $setCellsAlign(align: ElementFormatType) {
  for (const cell of $getTargetCells()) {
    for (const child of cell.getChildren()) {
      if ($isElementNode(child)) child.setFormat(align);
    }
  }
}

export function $isHeaderRow(table: TableNode): boolean {
  const cell = table.getFirstChild<TableRowNode>()?.getFirstChild<TableCellNode>();
  return cell ? cell.hasHeaderState(TableCellHeaderStates.ROW) : false;
}

export function $isHeaderColumn(table: TableNode): boolean {
  const rows = table.getChildren<TableRowNode>();
  const cell = rows[0]?.getChildren<TableCellNode>()[0];
  return cell ? cell.hasHeaderState(TableCellHeaderStates.COLUMN) : false;
}
