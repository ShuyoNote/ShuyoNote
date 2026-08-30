// M26 公式 — transform inline `$...$` text into InlineFormulaNode while editing.
// Only single-$ spans (not the block `$$...$$`, which is handled by the markdown
// element transformer). To limit false positives on money/units, require the
// opening `$` to be preceded by start/whitespace and the closing `$` followed by
// whitespace/end, and the inner text non-empty and not starting with a digit.
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { useCallback, useEffect } from "react";
import { TextNode } from "lexical";
import { $createInlineFormulaNode, $isInlineFormulaNode } from "../nodes/InlineFormulaNode";

// `$...$` on one line; exclude `$$` block already consumed by the element path.
const INLINE_RE = /(^|\s)\$([^$\n]+?)\$(?=\s|$)/g;

function transformTextNode(node: TextNode): boolean {
  if ($isInlineFormulaNode(node)) return false;
  const text = node.getTextContent();
  if (!text.includes("$")) return false;
  INLINE_RE.lastIndex = 0;
  const m = INLINE_RE.exec(text);
  if (!m) return false;
  const full = m[0];
  const start = m.index as number;
  const inner = m[2];
  const latex = inner.trim();
  // Skip when it looks like a bare number (e.g. "$5" or "$ 100") — avoid money/units.
  if (!latex || /^[\d.,]/.test(latex)) return false;
  const end = start + full.length;
  // Preserve the leading whitespace (m[1]) from the match before replacing.
  const leading = m[1] || "";

  const segments = node.splitText(start + leading.length, end);
  const target = segments.find((s) => s.getTextContent() === `$${latex}$`) || segments[0];
  if (target) {
    target.replace($createInlineFormulaNode(`$${latex}$`, latex));
  }
  return true;
}

export function InlineFormulaPlugin() {
  const [editor] = useLexicalComposerContext();
  const transform = useCallback((node: TextNode) => transformTextNode(node), []);
  useEffect(() => {
    return editor.registerNodeTransform(TextNode, transform);
  }, [editor, transform]);
  return null;
}
