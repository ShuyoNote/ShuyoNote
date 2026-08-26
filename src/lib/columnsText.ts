// Pure helper (no editor/node imports) that extracts the text of every Route-B
// columns-block column from a serialized page JSON. Column editors are nested
// LexicalComposer states, so they are NOT part of the page editor's
// $getRoot().getTextContent(); we must pull their text out of the serialized JSON
// ourselves to keep search/backlinks/graph working. Kept dependency-free so the
// Node smoke test can import it without dragging in the heavy editor graph.

function collectTextFromDoc(node: unknown, out: string[]) {
  if (!node || typeof node !== "object") return;
  const rec = node as Record<string, unknown>;
  if (typeof rec.text === "string") out.push(rec.text);
  // A column's EditorState JSON is `{root:{children:[...]}}` (or `{children:[...]}`).
  if (rec.root && typeof rec.root === "object") collectTextFromDoc(rec.root, out);
  if (Array.isArray(rec.children)) {
    for (const c of rec.children) collectTextFromDoc(c, out);
  }
  if (rec.$slots && typeof rec.$slots === "object") {
    for (const k of Object.keys(rec.$slots as Record<string, unknown>)) collectTextFromDoc((rec.$slots as Record<string, unknown>)[k], out);
  }
}

// Extract the text of every Route-B columns block's columns from a serialized page
// JSON, appended to the page's own root text so search/backlinks see column content.
export function collectColumnsText(contentJson: string): string {
  try {
    const parsed = JSON.parse(contentJson);
    const root = parsed?.root;
    if (!root || !Array.isArray(root.children)) return "";
    const out: string[] = [];
    for (const child of root.children) {
      if (child && (child as Record<string, unknown>).type === "columnsBlock" && Array.isArray((child as Record<string, unknown>).cols)) {
        for (const col of (child as Record<string, unknown>).cols as string[]) {
          try {
            collectTextFromDoc(JSON.parse(col), out);
          } catch {
            /* skip malformed column */
          }
        }
      }
    }
    return out.length ? "\n" + out.join(" ") : "";
  } catch {
    return "";
  }
}
