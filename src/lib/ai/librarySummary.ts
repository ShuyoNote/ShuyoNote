// P4：**跨库总结**（map-reduce）＋ **强制回链** —— 方案 §8 P4 的交付：
//   「map-reduce（分批读 → 分批总结 → 归并）；输出必须带 `att://` / `pdf://#page` / `blk-` 回链；
//    查不到就明确说查不到。」
//
// 三条设计取舍（都不是随手定的）：
//
// 1. **回链是硬约束，不是提示词里的礼貌请求**：模型吐回来的每一行都要过一遍
//    `filterClaims()` —— 没有回链的行**丢掉**、引用了本批不存在的回链的行**也丢掉**，
//    两种丢弃都**计数并回报**。理由与"不许凭空造数据"同一条：用户看不出来哪句是模型编的，
//    而"带不出来的结论"在跨库总结里恰恰是最危险的那种漂亮话（方案 §14 结尾就在说这件事）。
//
// 2. **reduce 是机械归并，不让模型再写一遍**：map 出来的每一批已经带了回链，
//    再让模型"把这些总结总结一下"是**回链最容易丢的一步**。所以归并 = 去重 + 拼接 +
//    统一抬头；代价是输出比"再总结一次"啰嗦，收益是**每一条结论都还挂着出处**。
//    （要更短的话，应该减少批数/收紧每条长度，而不是在最后一步赌一次模型。）
//
// 3. **不静默截断**：单个来源超过预算 ⇒ 它**单独成批**并标 `oversize`，
//    而不是悄悄切掉一半（切掉的那半会让"查不到"变成假话）。
//
// 回链语法（与仓里既有的对齐，不发明新的）：
//   · 页面     → `[[标题]]`（编辑器里的 wiki 链接，可点）
//   · PDF 页   → `pdf://<attId>#<pageIndex>`（`pdfAnnotation.ts::pdfRef`，0 基）
//   · 附件     → `att://<attId>`（方案 §P4 的写法；带段定位时 `att://<attId>#<loc>`）
//   · 块       → `blk-<id>`（`ai/apply.ts` 等新建块用的就是这一族 id）

/** 现有 `pdf://` 回链器（0 基页码）——**复用**它，别再写一份。 */
export { pdfRef, parsePdfRef } from "../pdfAnnotation";

/** 一次"给一段提示词、拿回一段文字"的调用（注入式：判据用假的，应用传自己的 transport）。 */
export type SummarizeFn = (prompt: string, opts?: { maxTokens?: number }) => Promise<string>;

export type SummarySourceKind = "page" | "attachment" | "pdf-page" | "block";

export interface SummarySource {
  /** **回链**（硬要求）。四种形状之一，见文件头。 */
  ref: string;
  kind: SummarySourceKind;
  /** 给人看的名字（页面标题 / 附件名）。 */
  label?: string;
  /** 送给模型的正文（取自已抽取/已分块的派生文本）。 */
  text: string;
}

export interface SummaryBatch {
  /** 本批覆盖的来源回链（顺序即输入顺序）。 */
  refs: string[];
  /** 本批字符数（用于判据钉住"不超预算"）。 */
  chars: number;
  /** 单个来源就超预算 ⇒ 单独成批并标它（见文件头第 3 条）。 */
  oversize: boolean;
  /** 模型原始输出（未过滤）。 */
  raw: string;
  /** 过滤后留下的行。 */
  kept: string[];
  /** 丢掉的"没有回链"的行数。 */
  droppedUnreferenced: number;
  /** 丢掉的"引用了本批不存在的回链"的行数。 */
  droppedInventedRefs: number;
}

export interface LibrarySummary {
  /** 可直接插成笔记块的 Markdown（每条结论都带回链）。 */
  markdown: string;
  /** 输出里出现的回链（去重、按首次出现排序）。 */
  refs: string[];
  batches: SummaryBatch[];
  droppedUnreferenced: number;
  droppedInventedRefs: number;
  /** true = 库里没有可用内容 ⇒ 输出里**明确说查不到**（而不是编一段）。 */
  notFound: boolean;
}

// ---------------------------------------------------------------------------
// 回链的识别与过滤
// ---------------------------------------------------------------------------

/** 四种回链的**唯一**识别口径（顺序无关；`extractRefs` 用它扫文本）。 */
const REF_PATTERNS: readonly RegExp[] = [
  /\[\[[^\]\n]{1,120}\]\]/g, // [[页面标题]]
  /\bpdf:\/\/[^\s#)]+#\d+\b/g, // pdf://att-1#3（0 基页码）
  /\batt:\/\/[^\s#)]+(?:#[^\s)]+)?/g, // att://att-1 或 att://att-1#p.12
  /\bblk-[A-Za-z0-9_-]{4,}\b/g, // blk-<id>
];

/** 抽出文本里的全部回链（按出现顺序，保留重复 —— 调用方自己去重）。 */
export function extractRefs(text: string): string[] {
  const out: { at: number; ref: string }[] = [];
  for (const re of REF_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text ?? "")) !== null) out.push({ at: m.index, ref: m[0] });
  }
  return out.sort((a, b) => a.at - b.at).map((x) => x.ref);
}

/** 去重但保序（回链的"首次出现顺序"是有意义的：它大致反映材料顺序）。 */
export function uniqueRefs(refs: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of refs) {
    if (seen.has(r)) continue;
    seen.add(r);
    out.push(r);
  }
  return out;
}

/** 一行是不是"结论行"（标题/空白/水平线不算结论，允许不带回链）。 */
export function isClaimLine(line: string): boolean {
  const t = line.trim();
  if (t.length === 0) return false;
  if (/^#{1,6}\s/.test(t)) return false; // 标题
  if (/^([-*_])\1{2,}$/.test(t)) return false; // ---
  return true;
}

/** 明确的"查不到"行 —— 它是**诚实声明**，不是关于内容的结论，所以不受"必须带回链"约束。 */
export function isNotFoundLine(line: string): boolean {
  return /^\s*查不到\s*[:：]/.test(String(line ?? ""));
}

export interface ClaimFilterResult {
  kept: string[];
  droppedUnreferenced: number;
  droppedInventedRefs: number;
}

/**
 * 结论行过滤：**没有回链的丢掉；引用了本批不存在的回链的也丢掉**（两种都计数）。
 *
 * 为什么"本批不存在"要单独计数：那是**编造回链**——比没有回链更坏，因为它看起来有出处。
 * 为什么"查不到"那行例外：它是**诚实声明**（方案 §P4 明确要求"查不到就明确说查不到"），
 * 若把它按"没有回链的结论"丢掉，就等于**惩罚诚实**，逼模型下一轮去编一条带出处的假结论。
 */
export function filterClaims(answer: string, allowedRefs: readonly string[]): ClaimFilterResult {
  const allowed = new Set(allowedRefs);
  const kept: string[] = [];
  let droppedUnreferenced = 0;
  let droppedInventedRefs = 0;
  for (const line of String(answer ?? "").split(/\r?\n/)) {
    if (isNotFoundLine(line)) {
      kept.push(line); // 诚实声明：直接放行，不计入丢弃
      continue;
    }
    if (!isClaimLine(line)) {
      if (line.trim().length > 0) kept.push(line); // 标题保留（有结构价值，不当作结论）
      continue;
    }
    const refs = extractRefs(line);
    if (refs.length === 0) {
      droppedUnreferenced++;
      continue;
    }
    if (refs.some((r) => !allowed.has(r))) {
      droppedInventedRefs++;
      continue;
    }
    kept.push(line);
  }
  return { kept, droppedUnreferenced, droppedInventedRefs };
}

// ---------------------------------------------------------------------------
// 分批（不静默截断）
// ---------------------------------------------------------------------------

export function planBatches(
  sources: readonly SummarySource[],
  budgetChars: number,
): { refs: string[]; chars: number; oversize: boolean; text: string }[] {
  const usable = sources.filter((s) => String(s.text ?? "").trim().length > 0);
  const out: { refs: string[]; chars: number; oversize: boolean; text: string }[] = [];
  let cur: { refs: string[]; chars: number; oversize: boolean; text: string } | null = null;
  const flush = () => {
    if (cur) out.push(cur);
    cur = null;
  };

  for (const s of usable) {
    const chunk = `${s.ref}\n${String(s.text).trim()}\n`;
    if (chunk.length > budgetChars) {
      // 单个来源超预算 ⇒ **单独成批、原样送**（不切它，见文件头第 3 条）
      flush();
      out.push({ refs: [s.ref], chars: chunk.length, oversize: true, text: chunk });
      continue;
    }
    if (cur && cur.chars + chunk.length > budgetChars) flush();
    if (!cur) cur = { refs: [], chars: 0, oversize: false, text: "" };
    cur.refs.push(s.ref);
    cur.chars += chunk.length;
    cur.text += chunk;
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// map-reduce
// ---------------------------------------------------------------------------

const SYSTEM = [
  "你在做「跨库总结」：材料来自用户自己的笔记库，每条材料前面都带着**回链**。",
  "硬规则（违反的整行会被丢弃，不要试探）：",
  "1. **每一条结论行都必须引用至少一个回链**，回链原样照抄（形如 [[标题]] / pdf://att-id#页码 / att://att-id / blk-id）。",
  "2. **只允许引用材料里出现过的回链**；不要发明回链，也不要写材料里没有的事实。",
  "3. 材料里没有相关内容时，只输出一行：`查不到：本批材料里没有与问题相关的内容`。",
  "4. 用中文，短句，一行一条结论；不要写「根据材料」这类空话。",
].join("\n");

export interface MapReduceOptions {
  sources: readonly SummarySource[];
  /** 每批字符预算（默认 4000：给留出提示词与输出的余量）。 */
  budgetChars?: number;
  summarize: SummarizeFn;
  /** 提问（决定"总结什么"）。默认=无特定问题，做通用归纳。 */
  question?: string;
  onProgress?: (done: number, total: number, refs: readonly string[]) => void;
}

/**
 * 分批读 → 分批总结（**每批强制回链**）→ 机械归并。
 *
 * 返回的 `markdown` 可以直接插成一个笔记块：每条结论都挂着回链，点得回去。
 */
export async function mapReduceSummarize(opts: MapReduceOptions): Promise<LibrarySummary> {
  const budgetChars = opts.budgetChars ?? 4000;
  const planned = planBatches(opts.sources, budgetChars).filter((b) => b.text.trim().length > 0);

  if (planned.length === 0) {
    // 库里没有可用内容 ⇒ **明确说查不到**，且**不打模型**（不花冤枉钱、也不给编造的机会）
    return {
      markdown: "查不到：库里没有可总结的内容（页面/附件都还没有可检索的文本）。\n",
      refs: [],
      batches: [],
      droppedUnreferenced: 0,
      droppedInventedRefs: 0,
      notFound: true,
    };
  }

  const question = opts.question?.trim()
    ? `用户的问题：${opts.question.trim()}`
    : "用户没有提出具体问题：请归纳这批材料里**最值得记下来**的要点。";

  const batches: SummaryBatch[] = [];
  for (let i = 0; i < planned.length; i++) {
    const b = planned[i];
    const prompt = [
      SYSTEM,
      "",
      question,
      "",
      `材料（第 ${i + 1}/${planned.length} 批，共 ${b.refs.length} 条来源${b.oversize ? "，本条来源超出单批预算已单独成批" : ""}）：`,
      b.text,
    ].join("\n");
    const raw = await opts.summarize(prompt);
    const filtered = filterClaims(raw, b.refs);
    batches.push({
      refs: b.refs,
      chars: b.chars,
      oversize: b.oversize,
      raw,
      kept: filtered.kept,
      droppedUnreferenced: filtered.droppedUnreferenced,
      droppedInventedRefs: filtered.droppedInventedRefs,
    });
    opts.onProgress?.(i + 1, planned.length, b.refs);
  }

  const droppedUnreferenced = batches.reduce((n, b) => n + b.droppedUnreferenced, 0);
  const droppedInventedRefs = batches.reduce((n, b) => n + b.droppedInventedRefs, 0);
  const keptLines = batches.flatMap((b) => b.kept);
  // "查不到"是声明，不是结论 ⇒ 从结论行里剔出去（否则它会假扮成一条有效结论）
  const notFoundLine = keptLines.find(isNotFoundLine);
  const bodyLines = keptLines.filter((l) => isClaimLine(l) && !isNotFoundLine(l));
  const refs = uniqueRefs(bodyLines.flatMap((l) => extractRefs(l)));

  const head = opts.question?.trim() ? `## 跨库总结：${opts.question.trim()}` : "## 跨库总结";
  const notes: string[] = [];
  if (droppedUnreferenced > 0) notes.push(`另有 ${droppedUnreferenced} 条结论因**没有回链**被丢弃`);
  if (droppedInventedRefs > 0) notes.push(`${droppedInventedRefs} 条因**引用了不存在的回链**被丢弃`);

  const markdown =
    bodyLines.length === 0
      ? `${notFoundLine?.trim() || "查不到：材料里没有与问题相关的、且能给出处的内容。"}${
          notes.length ? `（${notes.join("；")}）` : ""
        }\n`
      : `${head}\n\n${bodyLines.join("\n")}\n\n---\n覆盖 ${refs.length} 个来源，共 ${batches.length} 批。${
          notes.length ? ` ${notes.join("；")}。` : ""
        }\n`;

  return {
    markdown,
    refs,
    batches,
    droppedUnreferenced,
    droppedInventedRefs,
    notFound: bodyLines.length === 0,
  };
}

// ---------------------------------------------------------------------------
// 给应用用的适配器（把已配置的 transport 包成 `SummarizeFn`）
// ---------------------------------------------------------------------------

export function summarizerFromTransport(
  transport: {
    complete(
      messages: { role: "system" | "user" | "assistant"; content: string }[],
      opts?: { maxTokens?: number; temperature?: number },
    ): Promise<{ content: string }>;
  },
  maxTokens = 1024,
): SummarizeFn {
  return async (prompt) => {
    const r = await transport.complete(
      [
        { role: "system", content: "你是一个严谨的笔记总结助手。" },
        { role: "user", content: prompt },
      ],
      { maxTokens, temperature: 0.2 },
    );
    return r.content ?? "";
  };
}
