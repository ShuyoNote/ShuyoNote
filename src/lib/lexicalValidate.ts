// Defensive validation of a serialized Lexical editor state. A saved doc can
// contain a node object whose `type` is missing (rendered as the string
// "undefined" by Lexical), which makes parseEditorState throw and crashes the
// whole editor. The definitive rule: every element of a `children` array (at the
// root and nested) is a NODE and must carry a string `type`. An object in a
// `children` position without a `type` is corrupt → we return null and the
// caller falls back to an empty editor. Non-node data arrays (e.g. an ImageRow's
// `items`, which are plain {src,alt,...}) are NOT `children` and are left alone.

function validateNodes(children: unknown): boolean {
  if (!Array.isArray(children)) return true;
  return children.every((child) => {
    if (!child || typeof child !== "object") return false;
    const c = child as Record<string, unknown>;
    if (typeof c.type !== "string" || !c.type) return false;
    return validateNodes(c.children);
  });
}

/** @returns the contentJson if it is a usable, well-formed Lexical doc, else null. */
export function lexicalStateValid(contentJson: string): string | null {
  try {
    const parsed = JSON.parse(contentJson);
    const root = parsed && parsed.root;
    if (root && Array.isArray(root.children) && root.children.length > 0) {
      if (!validateNodes(root.children)) return null;
      return contentJson;
    }
  } catch {
    // fall through to empty
  }
  return null;
}
