// P4 的**取材 + 运行**层（纯逻辑，不含 DOM）：把"库里已索引的内容"取成带**回链**的来源，
// 交给 `librarySummary.mapReduceSummarize` 去分批总结。界面只负责接按钮 / 进度 / 落块。
//
// ## 为什么取材只从**已索引的块**（`chunks`）拿，而不是重读原文
// 1. **单一真相**：检索面找得到的东西 = 总结看得到的东西。若这里另读一份原文，
//    就会出现"检索说这页没索引、总结却能引它"这种两面不一致；
// 2. **回链真能点回去**：块的 `loc` 就是回链的依据（PDF 的 `p.<n>` → `pdf://att#n-1`）；
// 3. **代价明确**：没索引就没得总结 ⇒ 这时**如实报出来**（`skipped`），
//    而不是悄悄少一段、让用户以为"库里就这些"。
//
// ## 三条刻意的不变量
// 1. **每个发出去的回链都必须能被 `extractRefs` 认出来**（见 `isCitable`）。
//    这是最容易漏的坑：模型是被要求"回链原样照抄"的，若我发一个它认不出的回链，
//    它抄回来会被自己的过滤器判成"没有出处"整行丢掉 —— **整批结论全灭，还查不出原因**。
//    ⇒ 认不出的来源宁可不送，并在 `skipped` 里说明（见 `pageRefOf`）。
// 2. **不静默截断**：总预算到顶后剩下的来源**逐条进 `skipped`**，不偷偷切文本。
//    （分批本身不丢内容：`planBatches` 会让超预算的单条**单独成批**。）
// 3. **平台不支持就不装**：与「开始索引」同一口径（复用 `indexAvailability`），
//    界面不许承诺做不到的事。
//
// ⚠️ 红线：**不遍历用户磁盘**。页面来自 `api.listPages`、附件来自 `api.listPageAttachments`
// （即"已导入"的那些），与 `indexLibrary` 同一条边界。

import { api } from "../api";
import { pdfRef } from "../pdfAnnotation";
import { indexAvailability } from "../libraryIndexing";
import type { Chunk } from "../extract/chunk";
import type { IndexPageStores } from "../indexPage";
import type { Platform } from "../platform/types";
import {
  extractRefs,
  mapReduceSummarize,
  type LibrarySummary,
  type SummarySource,
  type SummarizeFn,
} from "./librarySummary";

/** 一次取材的字数上限（默认 4 万字 ≈ 10 批；本地小模型跑一批要十几秒，再大用户等不起）。 */
export const DEFAULT_MAX_CHARS_TOTAL = 40_000;

export interface SourceSkip {
  /** 本来会用的回链（回链本身不可用时退化成一句人话）。 */
  ref: string;
  reason: string;
}

export interface CollectedSources {
  sources: SummarySource[];
  skipped: SourceSkip[];
  chars: number;
  /** 真进了取材的页面数 / 附件数。 */
  pages: number;
  attachments: number;
  /** 平台不支持时的原因（有它 ⇒ `sources` 必为空）。 */
  blocked?: string;
}

/** 页面回链：`[[标题]]`。标题不可用时返回 null（调用方据此跳过并说明）。 */
export function pageRefOf(title: string): string | null {
  const ref = `[[${String(title ?? "").trim()}]]`;
  return isCitable(ref) ? ref : null;
}

/**
 * 这个回链能不能被 `extractRefs` 原样认出来。
 *
 * 判据就是"自己扫自己"：认不出 ⇒ 模型照抄也会被判成没出处（见文件头第 1 条）。
 */
export function isCitable(ref: string): boolean {
  return extractRefs(ref).includes(ref);
}

/** 页面级 chunk 的正文（按 ord 顺序拼）。 */
function textOf(chunks: readonly Chunk[]): string {
  return chunks
    .map((c) => String(c.text ?? "").trim())
    .filter((t) => t.length > 0)
    .join("\n\n");
}

/** PDF 段落的 `p.<n>`（1 基）→ 0 基页号；不是页码定位的返回 null。 */
export function pageNumberOf(loc: string): number | null {
  const m = /^p\.(\d+)$/.exec(String(loc ?? "").trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 1 ? n : null;
}

function looksPdf(name: string, mime: string): boolean {
  return /pdf/i.test(String(mime ?? "")) || /\.pdf$/i.test(String(name ?? ""));
}

export interface CollectSummarySourcesOptions {
  platform: Platform;
  /** 只总结这些页面；省略 = 全库（`api.listPages`）。 */
  pageIds?: readonly string[];
  /** 未整理附件（`page_id IS NULL`）算不算。默认算：它们是库的一部分，`indexLibrary` 也索引它们。 */
  includeUnfiled?: boolean;
  maxCharsTotal?: number;
}

/**
 * 取一次跨库总结要用的来源（页面 + 页面附件 + 未整理附件）。
 *
 * 顺序是**确定的**：页面按 `listPages` 的顺序（逐个）、每页的附件紧随其后、最后是未整理附件
 * —— 于是"材料顺序"稳定，回链的首次出现顺序也就稳定。
 */
export async function collectSummarySources(opts: CollectSummarySourcesOptions): Promise<CollectedSources> {
  const avail = indexAvailability(opts.platform);
  if (!avail.supported) {
    return { sources: [], skipped: [], chars: 0, pages: 0, attachments: 0, blocked: avail.reason };
  }
  const budget = Number.isFinite(opts.maxCharsTotal) && (opts.maxCharsTotal as number) > 0
    ? Math.floor(opts.maxCharsTotal as number)
    : DEFAULT_MAX_CHARS_TOTAL;
  const stores: IndexPageStores = await opts.platform.derivedStores!();

  const sources: SummarySource[] = [];
  const skipped: SourceSkip[] = [];
  let chars = 0;
  let pages = 0;
  let attachments = 0;
  /** 预算到顶之后剩下的**全部**如实列出（一条也不偷偷丢）。 */
  let budgetHit = false;

  const add = (src: SummarySource) => {
    if (!isCitable(src.ref)) {
      // 不该发生（回链在构造时就校验过）——真发生了要吵，别静默少一条来源。
      skipped.push({ ref: src.ref, reason: "回链形状过滤器认不出来，这条没送（否则模型抄回来会被判成没出处）" });
      return;
    }
    const len = src.text.length;
    if (len === 0) {
      skipped.push({ ref: src.ref, reason: "没有可检索文本（先点「开始索引」）" });
      return;
    }
    if (len > budget) {
      skipped.push({ ref: src.ref, reason: `单条就有 ${len} 字，超出本次取材上限 ${budget} 字` });
      return;
    }
    if (chars + len > budget) {
      budgetHit = true;
      skipped.push({ ref: src.ref, reason: `已达本次取材上限 ${budget} 字，这条没送（可缩小范围后重试）` });
      return;
    }
    sources.push(src);
    chars += len;
  };

  // ---- ① 页面（正文块） ----
  const listed = opts.pageIds?.length
    ? await Promise.all(
        // 去重：调用方给了重复 id（或同一次里既点全库又点某页）也只是同一页，不该出两条来源
        [...new Set(opts.pageIds)].map(async (id) => {
          const p = await api.getPage(id);
          if (!p) skipped.push({ ref: id, reason: "页面不存在（可能已删除）" });
          return p ? { id: p.id, title: String(p.title ?? "") } : null;
        }),
      ).then((rows) => rows.filter((r): r is { id: string; title: string } => r !== null))
    : (await api.listPages()).map((p) => ({ id: p.id, title: String(p.title ?? "") }));

  for (const page of listed) {
    const ref = pageRefOf(page.title);
    if (!ref) {
      skipped.push({
        ref: `页面「${page.title}」`,
        reason: "标题构成不了可识别的回链（空标题 / 含 `]]` 或换行 / 超过 120 字）—— 改名后重试",
      });
      continue;
    }
    const text = textOf(await stores.chunks.chunksOf({ kind: "page", pageId: page.id }));
    if (text.length === 0) {
      skipped.push({ ref, reason: "还没有可检索文本（先点「开始索引」）" });
      continue;
    }
    add({ ref, kind: "page", label: page.title, text });
    pages++;
  }

  // ---- ② 附件（每页的 + 未整理） ----
  const atts: { id: string; name: string; mime: string }[] = [];
  const seen = new Set<string>();
  const remember = (list: readonly { id: string; name: string; mime: string }[]) => {
    for (const a of list) {
      if (seen.has(a.id)) continue; // 同一附件挂在多页上：只算一次（否则回链重复、内容翻倍）
      seen.add(a.id);
      atts.push({ id: a.id, name: String(a.name ?? ""), mime: String(a.mime ?? "") });
    }
  };
  for (const page of listed) remember(await api.listPageAttachments(page.id));
  if (opts.includeUnfiled !== false) remember(await api.listPageAttachments(null));

  for (const att of atts) {
    const chunks = await stores.chunks.chunksOf({ kind: "attachment", attId: att.id });
    if (chunks.length === 0) {
      skipped.push({ ref: `att://${att.id}`, reason: `附件「${att.name}」还没有可检索文本（先点「开始索引」）` });
      continue;
    }

    if (!looksPdf(att.name, att.mime)) {
      // 非 PDF：整份一个来源（docx/xlsx 的 `loc` 是块/单元格坐标，做成逐段回链对用户没意义）
      add({ ref: `att://${att.id}`, kind: "attachment", label: att.name, text: textOf(chunks) });
      attachments++;
      continue;
    }

    // PDF：**逐页一个来源**，回链是 `pdf://<attId>#<0 基页号>`
    const byPage = new Map<number, string[]>();
    let noPage = 0;
    for (const c of chunks) {
      const n = pageNumberOf(c.loc);
      const t = String(c.text ?? "").trim();
      if (t.length === 0) continue;
      if (n === null) {
        noPage++;
        continue;
      }
      const arr = byPage.get(n) ?? [];
      arr.push(t);
      byPage.set(n, arr);
    }
    if (noPage > 0) {
      skipped.push({
        ref: `att://${att.id}`,
        reason: `「${att.name}」有 ${noPage} 段没有页码定位，拿不到 pdf:// 回链，这部分没送`,
      });
    }
    for (const n of [...byPage.keys()].sort((a, b) => a - b)) {
      add({
        ref: pdfRef(att.id, n - 1),
        kind: "pdf-page",
        label: `${att.name} 第 ${n} 页`,
        text: byPage.get(n)!.join("\n"),
      });
    }
    attachments++;
  }

  if (budgetHit) {
    // 上限是"这一次不送了"，不是"永远没有"—— 说清怎么继续（别让用户以为内容丢了）
    skipped.push({ ref: "(取材范围)", reason: `本次只取了前 ${chars} 字（上限 ${budget}）` });
  }

  return { sources, skipped, chars, pages, attachments };
}

// ---------------------------------------------------------------------------
// 运行（面向界面）
// ---------------------------------------------------------------------------

export type LibrarySummaryRun =
  | {
      ok: true;
      summary: LibrarySummary;
      collected: CollectedSources;
      /** 一句人话（含取材与丢弃情况的实话），可直接进"工具"活动行。 */
      note: string;
    }
  | { ok: false; reason: string };

export interface RunLibrarySummaryOptions extends Omit<CollectSummarySourcesOptions, "platform"> {
  platform: Platform;
  summarize: SummarizeFn;
  question?: string;
  budgetChars?: number;
  onProgress?: (done: number, total: number, refs: readonly string[]) => void;
}

/**
 * 跑一次跨库总结：取材 → 分批总结 → 汇总。
 *
 * 平台不支持 / 库里没内容 ⇒ **不抛**，返回 `{ ok: false, reason }` 或让 `mapReduceSummarize`
 * 给出"查不到"的正文（两者都由界面显示成人话，而不是一个 `Error:`）。
 */
export async function runLibrarySummary(opts: RunLibrarySummaryOptions): Promise<LibrarySummaryRun> {
  const collected = await collectSummarySources(opts);
  if (collected.blocked) return { ok: false, reason: collected.blocked };
  if (collected.sources.length === 0) {
    return {
      ok: false,
      reason:
        collected.skipped.length > 0
          ? `库里还没有可总结的内容：${collected.skipped[0].reason}`
          : "库里还没有可总结的内容（页面与附件都还没有可检索文本）。",
    };
  }
  const summary = await mapReduceSummarize({
    sources: collected.sources,
    summarize: opts.summarize,
    ...(opts.question?.trim() ? { question: opts.question } : {}),
    ...(opts.budgetChars ? { budgetChars: opts.budgetChars } : {}),
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
  });
  return { ok: true, summary, collected, note: formatSummaryNote(summary, collected) };
}

/**
 * 一句人话：覆盖了多少来源、丢了几条结论、有多少内容没进来（前 3 条明细）。
 *
 * 为什么这三样都要说：`mapReduceSummarize` 的不变量是"不给出处的结论丢掉"，
 * 于是"总结很短"可能是**模型没给回链**，也可能是**库里没索引** ——
 * 两件事的下一步动作完全不同，只显示"总结完成"会把它们混成一件。
 */
export function formatSummaryNote(summary: LibrarySummary, collected: CollectedSources): string {
  const parts = [
    collected.pages > 0 || collected.attachments > 0
      ? `取材 ${collected.sources.length} 个来源（${collected.pages} 页 / ${collected.attachments} 个附件，${collected.chars} 字）`
      : `取材 ${collected.sources.length} 个来源（${collected.chars} 字）`,
    `覆盖 ${summary.refs.length} 个来源（${summary.batches.length} 批）`,
  ];
  const dropped = summary.droppedUnreferenced + summary.droppedInventedRefs;
  if (dropped > 0) {
    parts.push(
      `丢弃 ${dropped} 条结论（没回链 ${summary.droppedUnreferenced}、编回链 ${summary.droppedInventedRefs}）`,
    );
  }
  if (collected.skipped.length > 0) {
    const head = collected.skipped
      .slice(0, 3)
      .map((s) => `${s.ref}（${s.reason}）`)
      .join("、");
    const more = collected.skipped.length > 3 ? ` 等 ${collected.skipped.length} 条` : "";
    parts.push(`另有 ${collected.skipped.length} 条没进来：${head}${more}`);
  }
  return parts.join("；");
}

/**
 * 把总结插成笔记块的**草稿**（`append_block`，与 AI 工具同一条落库路径：用户点「应用」才写）。
 *
 * ⚠️ 没有当前页就不给草稿（返回 null）：总结**不自己挑一个页面写进去** ——
 * 那是"替用户决定写哪儿"，与"写操作需确认"是同一条边界。
 */
export function summaryDraft(
  summary: LibrarySummary,
  pageId: string | null | undefined,
): { kind: "append_block"; pageId: string; text: string } | null {
  const id = String(pageId ?? "").trim();
  const text = summary.markdown.trim();
  if (!id || !text) return null;
  return { kind: "append_block", pageId: id, text };
}

/**
 * 上面那条草稿的**信封**（`{key, summary, payload}`）—— 与 AI 工具面的 `blocks.append` **同一套约定**
 * （`key` 同形、`summary` 同风格 ⇒ 同一段内容被工具与总结各追加一次时会按 key 去重）。
 */
export function summaryDraftEntry(
  summary: LibrarySummary,
  pageId: string | null | undefined,
): { key: string; summary: string; payload: unknown } | null {
  const payload = summaryDraft(summary, pageId);
  if (!payload) return null;
  const paragraphs = payload.text.split("\n").filter((s) => s.trim().length > 0).length;
  return {
    key: `append_block:${payload.pageId}:${payload.text.slice(0, 24)}`,
    summary: `把跨库总结追加到当前页（${paragraphs} 个段落，每条结论都带回链）`,
    payload,
  };
}
