import { $isDecoratorNode, $isElementNode, type LexicalNode } from "lexical";

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
