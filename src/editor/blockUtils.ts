import { $isDecoratorNode, $isElementNode, type LexicalNode } from "lexical";
import { $isColumnNode } from "./nodes/ColumnNode";

// A top-level block is "empty" when it has no visible content: no text and no
// non-empty children. Used to show the Feishu-style inline "+" (insert-block)
// affordance over an empty block, and to hide the ⋮⋮ drag grip there too.
export function isEmptyBlock(node: LexicalNode | null | undefined): boolean {
  if (!node || !node.isAttached()) return false;
  if ($isDecoratorNode(node)) return false; // a top-level decorator block is content
  if (node.getTextContent().trim() !== "") return false;
  if (!$isElementNode(node)) return false;
  // A block with only empty text/whitespace children is still empty.
  return !node.getChildren().some((c) => {
    if ($isDecoratorNode(c)) return true;
    return c.getTextContent().trim() !== "";
  });
}

// Find the block node that the caret's insert/replace operation should target.
//
// For a paragraph inside a ColumnNode we must NOT operate on the whole ColumnsNode
// (which is what Lexical's getTopLevelElement() would return), or a single "/"
// insert would wipe all columns. Instead we stop at a COLUMN boundary: the target
// is the innermost block whose parent is a ColumnNode (or the root). This is what
// lets Tier-1 "in-column multi-block" work: pressing "/" inside a column replaces
// just that column's current block, keeping sibling columns intact.
export function $getInsertTargetBlock(anchor: LexicalNode): LexicalNode | null {
  let node: LexicalNode | null = anchor;
  for (;;) {
    if (!node) return null;
    const parent = node.getParent() as LexicalNode | null;
    if (!parent) return null;
    if ($isColumnNode(parent)) {
      // node is a block directly inside a column → this is the target.
      return node;
    }
    if (parent.getType() === "root") {
      // node is a top-level block → this is the target.
      return node;
    }
    // The anchor is nested deeper (e.g. inside a list item, quote, code) — climb to
    // its host block so replace/insert acts on the whole host block.
    node = parent;
  }
}
