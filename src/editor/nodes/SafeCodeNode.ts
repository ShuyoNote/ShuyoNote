import { CodeNode } from "@lexical/code";
import { $createParagraphNode, type NodeKey, type ParagraphNode, type RangeSelection } from "lexical";

// @lexical/code@0.49 CodeNode.insertNewAfter crashes ("getIndexWithinParent
// undefined") when CodeExtension isn't fully applied by the host. Subclass and
// override the offending method so pressing Enter at the end of a code block
// breaks out safely instead of throwing.
export class SafeCodeNode extends CodeNode {
  static getType(): string {
    return "code";
  }

  static clone(node: SafeCodeNode): SafeCodeNode {
    return new SafeCodeNode((node as any).__language, node.__key as NodeKey);
  }

  static importJSON(serializedNode: any): SafeCodeNode {
    const node = $createSafeCodeNode(serializedNode.language ?? "javascript", serializedNode.key);
    node.setFormat(serializedNode.format);
    node.setIndent(serializedNode.indent);
    node.setDirection(serializedNode.direction);
    return node;
  }

  insertNewAfter(_selection: RangeSelection, restoreSelection?: boolean): ParagraphNode {
    const block = $createParagraphNode();
    this.insertAfter(block);
    if (restoreSelection) block.selectStart();
    return block;
  }
}

export function $createSafeCodeNode(language?: string, key?: NodeKey): SafeCodeNode {
  return new SafeCodeNode(language ?? "javascript", key);
}
