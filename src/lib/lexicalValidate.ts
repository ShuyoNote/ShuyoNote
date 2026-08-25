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
  if (!c || typeof c !== "object" || Array.isArray(c)) return false;
  const t = (c as NodeRecord).type;
  // A non-empty string `type` is required; the literal "undefined"/"null" are not
  // real Lexical node types and would make parseEditorState throw "not found".
  return typeof t === "string" && t.length > 0 && t !== "undefined" && t !== "null";
}

function sanitizeChildren(children: unknown, allowedTypes?: ReadonlySet<string>): unknown[] {
  if (!Array.isArray(children)) return [];
  const out: unknown[] = [];
  for (const child of children) {
    if (!isNode(child)) continue;
    // When we know the editor's node registry, drop any type it cannot deserialize
    // (e.g. a stray/unregistered type) so it can never crash the editor or spam the
    // console with "type ... not found".
    if (allowedTypes && !allowedTypes.has(child.type)) continue;
    if (Array.isArray(child.children)) {
      child.children = sanitizeChildren(child.children, allowedTypes);
    }
    out.push(child);
  }
  return out;
}

/**
 * @returns a usable, well-formed Lexical doc string — with malformed or
 * unregistered children dropped — or null if the content is not a usable Lexical
 * document (unparseable, no `root`, or nothing survives sanitization).
 * @param allowedTypes optional set of node types the editor can deserialize;
 * when provided, any node with a type outside it is dropped.
 */
export function lexicalStateValid(contentJson: string, allowedTypes?: ReadonlySet<string>): string | null {
  try {
    const parsed = JSON.parse(contentJson);
    const root = parsed && (parsed as Record<string, unknown>).root;
    if (!root || typeof root !== "object") return null;
    const rootRec = root as Record<string, unknown>;
    const children = sanitizeChildren(rootRec.children, allowedTypes);
    rootRec.children = children;
    if (children.length === 0) return null;
    return JSON.stringify(parsed);
  } catch {
    return null;
  }
}
