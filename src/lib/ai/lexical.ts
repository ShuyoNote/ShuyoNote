// Text/Lexical helpers shared by the thin-AI tool layer. We manipulate the plain
// Lexical JSON (root children) on the FRONTEND and reuse the existing `save_page`
// command, so no new arbitrary backend command is introduced (minimal IPC surface).
//
// ⚠️ **这个模块必须保持"纯 JSON 逻辑"——不许 import 编辑器节点表。**
// 理由是一次真实事故（2026-09-18）：`contentTextOf` 原先在这里直接委托 `../contentText`
// （那层要 `editor/config` 的节点表才能解析文档），于是**任何** import 本模块的打包路径
// （`ai/tools` → `capabilities/frontend` → 本模块，`scripts/smoke-web.mjs` 的 AI 核心包）
// 都会被拖进整个编辑器节点图 —— excalidraw 的 CSS、katex 的字体、sql.js 的 wasm 一起进图，
// node 侧 esbuild 直接打不出来（`pnpm verify` 的 `smoke-web` 门禁红）。
// ⇒ 需要"编辑器语义"的正文派生（要节点表的那些）住在 `./lexicalContent`，由**编辑器侧**的
// 调用方 import；本模块只留纯函数。

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

/** 把任意文本切成"要落成块"的行：逐行 trim、去掉空行。
 *  `appendBlocksToJson` 与 `pageJsonFromText` **共用**它 —— 两处的行集合一旦不同，
 *  后者算出来的 `content_text` 就与前者造出来的文档对不上。 */
function docLines(text: string): string[] {
  return String(text ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Append one or more paragraph blocks (one per newline) to a page's content JSON. */
export function appendBlocksToJson(contentJson: string, text: string, makeId: () => string): string {
  const doc = safeRoot(contentJson);
  const lines = docLines(text);
  if (lines.length === 0) return contentJson;
  for (const line of lines) {
    (doc.root.children as LexicalBlock[]).push(paraNode(line, makeId()));
  }
  return JSON.stringify(doc);
}

/**
 * 由页面内容 JSON 取正文纯文本（预览/片段用）—— **已搬走**，见 `./lexicalContent`。
 *
 * 搬走的理由不是改名换姓，而是分层：它要的是"编辑器语义"（Lexical 的
 * `$getRoot().getTextContent()`），而那是唯一需要**编辑器节点表**的一条 ⇒ 它不能住在
 * 这个纯逻辑模块里，否则会把整个编辑器节点图拖进每一个 import 本模块的打包路径
 * （实测：`smoke-web` 门禁直接红）。语义没有变，唯一实现仍是 `lib/contentText.ts`。
 */

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
 *
 * `content_text` 在这里**按构造成本算**（`docLines(...).join("\n\n")`），而不是回头调
 * `deriveContentText` —— 因为那会把编辑器节点表拖进本模块（见文件头那条事故）。
 * 两套算法不许漂：`src/lib/ai/lexicalContent.test.ts` 用**配对判据**钉住
 * 「本函数算出的 `content_text`」逐字等于「编辑器语义派生同一份 `content_json` 的结果」，
 * 分隔符由 Lexical 定（根节点的元素分隔符是 `"\n\n"`），判据不写死它。
 */
export function pageJsonFromText(
  content: string,
  makeId: () => string,
): { content_json: string; content_text: string } {
  const lines = docLines(content);
  const content_json = lines.length
    ? appendBlocksToJson("", content, makeId)
    : '{"root":{"children":[],"type":"root","version":1}}';
  return { content_json, content_text: lines.join("\n\n") };
}
