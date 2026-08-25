// Defensive validation + SANITIZATION of a serialized Lexical editor state.
//
// A saved doc can contain a node object whose `type` is missing (rendered as the
// string "undefined" by Lexical) or unregistered, which makes parseEditorState
// throw and can crash the whole editor. Previously we rejected the ENTIRE
// document when any node was malformed, so a page with mostly-good content
// opened as a blank editor. Now we walk every `children` array recursively and
// DROP only the offending elements — any element that is not a node carrying a
// non-empty string `type` — salvaging the rest so real content still renders.
// If nothing survives or the input is not a usable Lexical doc we return null
// and the caller opens an empty editor.
//
// IMPORTANT: only a `children` array holds nodes. Non-node data arrays (e.g. an
// ImageRow's `items` of plain {src,alt,...}) are NOT `children` and are left
// untouched.

type NodeRecord = Record<string, unknown> & { type?: unknown };

function isNode(c: unknown): c is NodeRecord & { type: string } {
  return (
    !!c &&
    typeof c === "object" &&
    !Array.isArray(c) &&
    typeof (c as NodeRecord).type === "string" &&
    ((c as NodeRecord).type as string).length > 0
  );
}

function sanitizeChildren(children: unknown): unknown[] {
  if (!Array.isArray(children)) return [];
  const out: unknown[] = [];
  for (const child of children) {
    if (!isNode(child)) continue;
    if (Array.isArray(child.children)) {
      child.children = sanitizeChildren(child.children);
    }
    out.push(child);
  }
  return out;
}

/**
 * @returns a usable, well-formed Lexical doc string — with malformed children
 * dropped — or null if the content is not a usable Lexical document (unparseable,
 * no `root`, or nothing survives sanitization).
 */
export function lexicalStateValid(contentJson: string): string | null {
  try {
    const parsed = JSON.parse(contentJson);
    const root = parsed && (parsed as Record<string, unknown>).root;
    if (!root || typeof root !== "object") return null;
    const rootRec = root as Record<string, unknown>;
    const children = sanitizeChildren(rootRec.children);
    rootRec.children = children;
    if (children.length === 0) return null;
    return JSON.stringify(parsed);
  } catch {
    return null;
  }
}
