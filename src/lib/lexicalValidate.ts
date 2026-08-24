// Defensive validation of a serialized Lexical editor state. A saved doc can
// contain a node object whose `type` is missing (rendered as the string
// "undefined" by Lexical), which makes parseEditorState throw and crashes the
// whole editor. This scans the tree and rejects docs that contain such a
// "node-like" object without a `type`, so the caller falls back to an empty
// editor instead of crashing. Data-only objects (e.g. an ImageRow's `items`
// entries, which are plain {src,alt,...} and legitimately have no `type`) are
// left alone.

const NODE_KEYS = ["version", "children", "text", "format", "direction", "indent", "style", "tag"];

function isNodeLike(o: Record<string, unknown>): boolean {
  return "type" in o || NODE_KEYS.some((k) => k in o);
}

function treeValid(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(treeValid);
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (isNodeLike(o) && (typeof o.type !== "string" || !o.type)) {
      return false;
    }
    for (const k of Object.keys(o)) {
      if (k === "type") continue;
      if (!treeValid(o[k])) return false;
    }
    return true;
  }
  return true; // primitives are fine
}

/** @returns the contentJson if it is a usable, well-formed Lexical doc, else null. */
export function lexicalStateValid(contentJson: string): string | null {
  try {
    const parsed = JSON.parse(contentJson);
    const root = parsed && parsed.root;
    if (root && Array.isArray(root.children) && root.children.length > 0) {
      if (!treeValid(root.children)) return null;
      return contentJson;
    }
  } catch {
    // fall through to empty
  }
  return null;
}
