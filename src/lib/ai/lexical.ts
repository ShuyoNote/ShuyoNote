// Text/Lexical helpers shared by the thin-AI tool layer. We manipulate the plain
// Lexical JSON (root children) on the FRONTEND and reuse the existing `save_page`
// command, so no new arbitrary backend command is introduced (minimal IPC surface).
import { deriveContentText } from "../contentText";

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

/**
 * 由页面内容 JSON 取正文纯文本（预览/片段用）。
 *
 * ⚠️ **已改成唯一实现**（`lib/contentText.ts` 的 `deriveContentText`）：本函数原先自己 walk JSON、
 * 用**空格**连接，而编辑器保存路径用的是 Lexical 的 `$getRoot().getTextContent()`（块间换行）
 * ⇒ 实测 **7 个样本里 4 个两者结果不同**，也就是"谁最后保存决定了正文文本长什么样"
 * （FTS 命中/反链片段/预览会随后台路径漂）。现在两条路径共用一套语义。
 *
 * 保留这个名字：调用方很多（AI 层/PDF 注释面板），改名只会增加 diff；语义已经统一。
 */
export function contentTextOf(contentJson: string): string {
  return deriveContentText(contentJson);
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

/**
 * 由纯文本构造新页面的 content_json（空内容给一个合法的空 root）。
 *
 * 放在这里而不是各调用方：**Lexical 的块结构只该在这一层被知道**。
 * 插件侧（Rust）只交出纯文本，落库时由这里构造 JSON。
 */
export function pageJsonFromText(
  content: string,
  makeId: () => string,
): { content_json: string; content_text: string } {
  const content_json = String(content ?? "").trim()
    ? appendBlocksToJson("", content, makeId)
    : '{"root":{"children":[],"type":"root","version":1}}';
  return { content_json, content_text: contentTextOf(content_json) };
}
