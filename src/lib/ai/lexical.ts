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

function safeRoot(contentJson: string): { root: { children: unknown[]; type: string; version: number } } {
  try {
    const v = JSON.parse(contentJson || "{}");
    const root = (v?.root && Array.isArray(v.root.children) ? v.root : { children: [] }) as {
      children: unknown[];
      version?: unknown;
    };
    // Lexical requires the root node to carry `type: "root"` (and a version) or it
    // throws `type "undefined" + not found`. Normalize so all AI-generated docs are
    // parseable even when the source omitted it.
    return { root: { ...root, type: "root", version: typeof root.version === "number" ? root.version : 1 } };
  } catch {
    return { root: { children: [], type: "root", version: 1 } };
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

/** Strip markdown markers and pure-separator/HR lines so AI-drafted content can be
 *  committed as clean plain text (a residue-safe belt for the inline writer). */
export function cleanDraftText(text: string): string {
  return String(text ?? "")
    .split("\n")
    .map((line) => {
      const t = line.trim();
      // separator / horizontal-rule only lines
      if (/^[-*_=]{3,}$/.test(t)) return "";
      return t.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*]+)\*/g, "$1").replace(/`([^`]+)`/g, "$1");
    })
    .filter(Boolean)
    .join("\n");
}
