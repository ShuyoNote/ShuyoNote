// M19/Wiki — transform plain `[[Page Title]]` text into inline, clickable
// `PageLinkNode`s while editing (and keep the literal text on serialize). Uses
// Lexical's `registerNodeTransform` so it works live on every text change.
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { useCallback, useEffect } from "react";
import { TextNode } from "lexical";
import { $createPageLinkNode, $isPageLinkNode } from "../nodes/PageLinkNode";

// Same grammar as `src/lib/wikiExport.ts`'s LINK_RE so links created here match
// what wiki export / backlinks / mention detection expect.
const LINK_RE = /\[\[([^\]|#]+)(?:\|([^\]|#]*))?(?:#([^\]]*))?\]\]/g;

function countMatches(text: string): number {
  LINK_RE.lastIndex = 0;
  let n = 0;
  while (LINK_RE.exec(text)) n++;
  return n;
}

/**
 * Split a text node so a `[[...]]` span becomes its own PageLinkNode. Returns
 * true if the node was transformed (so Lexical re-awaits the transform pass).
 */
function transformTextNode(node: TextNode): boolean {
  // Never operate on an existing page-link node or on text without [[ ]].
  if ($isPageLinkNode(node)) return false;
  const text = node.getTextContent();
  if (!text.includes("[[")) return false;
  LINK_RE.lastIndex = 0;
  const m = LINK_RE.exec(text);
  if (!m) return false;
  const full = m[0]; // includes the [[ ]] wrappers
  const start = m.index as number;
  const end = start + full.length;
  const title = (m[1] || "").trim();
  if (!title) return false;

  // Split the text node into [before, link, after] using text offsets.
  const segments = node.splitText(start, end);
  // splitText returns nodes starting at each split offset; [0] is the node
  // containing [start, ...]. The link text is the part we replace.
  const target = segments.find((s) => s.getTextContent() === full) || segments[0];
  if (target) {
    // Keep the literal `[[…]]` as the node's text so content_text (search /
    // backlinks / wiki export) stays identical; pageTitle drives click-jump.
    const link = $createPageLinkNode(full, title);
    target.replace(link);
  }
  return true;
}

export function PageLinkPlugin() {
  const [editor] = useLexicalComposerContext();

  const transform = useCallback((node: TextNode) => transformTextNode(node), []);

  useEffect(() => {
    return editor.registerNodeTransform(TextNode, transform);
  }, [editor, transform]);

  return null;
}

export { countMatches };
