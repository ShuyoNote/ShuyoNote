// 纯文本抽取器：txt / md / csv / json / log / yaml… → 段。
// 契约见 docs/plans/2026-09-17-knowledge-base-ai-coverage-plan.md §15。
//
// 为什么它值得一个独立抽取器：方案 §5 的抽取矩阵里「txt / md / csv / json」那一行写的是「直读」，
// 但**当时并没有实现**。真样张跑器一把仓库外的 docs 目录指过去，满屏 `no_extractor` ——
// 全是 `.md`。这类文件在知识库里占比不小，而且是**零解析成本**的一类，漏掉它没道理。
//
// 分段口径（刻意保持简单，不越界去做 P2 的分块）：
//  - 按**空行**切成块，一块一段；`loc` = `L<块首行号>`（行号是纯文本唯一稳定的定位）。
//  - ATX 标题（`# ` ~ `###### `）的块标成 `heading`，与 docx 一致。
//  - ⚠️ **块数超过 MAX_BLOCKS 就退回"整篇一段"**：防的是把一份几 MB 的日志切成十万行入库
//    （那会把派生表撑爆，而这类输入没有任何结构价值）。这是**有意的退化**，不是 bug。

import {
  fail,
  ok,
  type ExtractInput,
  type ExtractResult,
  type ExtractedSegment,
  type Extractor,
} from "./types";

const TEXT_ID = "text.plain@1";

/** 超过这个块数就退回"整篇一段"（见文件头注释）。 */
export const MAX_BLOCKS = 2000;

/** 认领的扩展名（不含 .pdf/.docx——那些有自己的抽取器，且会先按 mime 命中）。 */
const TEXT_EXTENSIONS = [
  ".txt",
  ".text",
  ".md",
  ".markdown",
  ".csv",
  ".tsv",
  ".json",
  ".jsonl",
  ".ndjson",
  ".log",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".conf",
  ".srt",
  ".vtt",
];

/** 前 8KB 里出现 NUL ⇒ 当作二进制（防止把误命名成 .txt 的二进制抽成乱码）。 */
function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8192);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

/** 去掉 UTF-8 BOM。 */
function decode(bytes: Uint8Array): string {
  const s = new TextDecoder("utf-8").decode(bytes);
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function isHeading(block: string): boolean {
  return /^#{1,6}\s+\S/.test(block.trimStart());
}

function extractText(input: ExtractInput): ExtractResult {
  if (looksBinary(input.bytes)) {
    // 不是我的格式 ⇒ unsupported（让调度器去换一个抽取器，而不是判文件坏了）
    return fail(TEXT_ID, "unsupported", "看起来是二进制（前 8KB 含 NUL）");
  }

  const raw = decode(input.bytes).replace(/\r\n?/g, "\n");
  if (raw.trim().length === 0) return fail(TEXT_ID, "empty", "文件是空的（或只有空白）");

  // 切成块，同时记录每块的首行号（1 基，给人看的）。
  //
  // ⚠️ 标题行**自己起一块**：真实 markdown 里标题后面常常**没有空行**，
  // 若只按空行切，"# 标题\n正文"会合成一个块、整块被标成 `heading`（正文就丢了类型）。
  // 所以遇到标题就先把上一块收掉，再以该行为新块起点。
  const lines = raw.split("\n");
  const blocks: { text: string; line: number }[] = [];
  let buf: string[] = [];
  let start = 1;
  const flush = (nextStart: number) => {
    const text = buf.join("\n").replace(/[ \t]+$/gm, "").trim();
    if (text.length > 0) blocks.push({ text, line: start });
    buf = [];
    start = nextStart;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") {
      flush(i + 2); // 下一个非空行的行号（空行本身不算内容）
    } else if (isHeading(line)) {
      flush(i + 1); // 先收掉上一块（若有）
      buf.push(line);
      flush(i + 2); // 标题独立成块
    } else {
      buf.push(line);
    }
  }
  flush(lines.length + 1);

  let segments: ExtractedSegment[];
  if (blocks.length > MAX_BLOCKS) {
    // 有意的退化：块太多 ⇒ 整篇一段（定位也只到文件级）
    segments = [{ kind: "text", text: raw.replace(/[ \t]+$/gm, "").trim(), loc: "" }];
  } else {
    segments = blocks.map((b) => ({
      kind: isHeading(b.text) ? ("heading" as const) : ("text" as const),
      text: b.text,
      loc: `L${b.line}`,
    }));
  }

  const kept = segments.filter((s) => s.text.length > 0);
  if (kept.length === 0) return fail(TEXT_ID, "empty", "没有可抽取的文本");
  return ok(TEXT_ID, kept);
}

export const textExtractor: Extractor = {
  id: TEXT_ID,
  mimes: ["text/*", "application/json", "application/xml", "application/x-ndjson"],
  extensions: TEXT_EXTENSIONS,
  cost: "cpu",
  extract: async (input: ExtractInput): Promise<ExtractResult> => {
    try {
      return extractText(input);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return fail(TEXT_ID, "internal", msg);
    }
  },
};
