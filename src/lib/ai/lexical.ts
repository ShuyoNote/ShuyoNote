// Text/Lexical helpers shared by the thin-AI tool layer. We manipulate the plain
// Lexical JSON (root children) on the FRONTEND and reuse the existing `save_page`
// command, so no new arbitrary backend command is introduced (minimal IPC surface).

// Normalize arbitrary content into a Lexical paragraph node (blockId assigned by
// callers). `text` may contain `\n` → split into multiple paragraph nodes.
export interface LexicalBlock {
  blockId?: string;
  type: string;
  children: unknown[];
  [k: string]: unknown;
}

function textNode(text: string): Record<string, unknown> {
  return { type: "text", text, detail: 0, format: 0, mode: "normal", style: "", version: 1 };
}

function paraNode(text: string, blockId: string): LexicalBlock {
  return {
    blockId,
    type: "paragraph",
    version: 1,
    direction: "ltr",
    format: "",
    indent: 0,
    style: "",
    children: [textNode(text)],
  };
}

function safeRoot(contentJson: string): { root: { children: unknown[] } } {
  try {
    const v = JSON.parse(contentJson || "{}");
    return { root: v?.root && Array.isArray(v.root.children) ? v.root : { children: [] } };
  } catch {
    return { root: { children: [] } };
  }
}

/** Append one or more paragraph blocks (one per newline) to a page's content JSON. */
export function appendBlocksToJson(contentJson: string, text: string, makeId: () => string): string {
  const doc = safeRoot(contentJson);
  const lines = String(text ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (lines.length === 0) return contentJson;
  for (const line of lines) {
    (doc.root.children as LexicalBlock[]).push(paraNode(line, makeId()));
  }
  return JSON.stringify(doc);
}

/** Extract the plain text of a page's content JSON (for previews/snippets). */
export function contentTextOf(contentJson: string): string {
  const doc = safeRoot(contentJson);
  const out: string[] = [];
  const walk = (n: any) => {
    if (!n || typeof n !== "object") return;
    if (n.type === "text" && typeof n.text === "string") out.push(n.text);
    if (Array.isArray(n.children)) n.children.forEach(walk);
  };
  (doc.root.children as any[]).forEach(walk);
  return out.join(" ");
}
