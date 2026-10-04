// 第三块（按需单页）· **纯函数层**：把一个「专题分区」＋ 选中的材料，变成**一页草稿**。
//
// ## 这一层刻意只做四件事（其余都复用既有面，不另造第二条路径 ✓）
// 1. **回链只来自输入** —— 复用 `librarySummary.ts` 的 `filterClaims(answer, allowedRefs)`（它已经在守这条 ✓），
//    本文件**不重写**校验，只负责把"允许的 ref 集合"算出来喂给它 ✓
// 2. **覆盖度不许留空** —— 没读数 ⇒ 写「未知」（**不许写 0**，与面板那条口径同源 ✓）
// 3. **页脚「派生，非出处」** —— 每页都带，另附模型名与生成时间 ✓
// 4. **不落库** —— 本模块**不 import** `apply` / `platform` / `stores` / `api`（有静态断言守着 ✓），
//    也不写任何 `pages` 行 ⇒ 出的是**草稿**，采不采纳是人的事 ✓（`INV-WIKI-readonly-default` ✓）
//
// ⚠️ **本层没有的东西（如实说）**：没有"取消"信号（`LlmOptions` 里没有 `signal`）⇒ 取消只能是
//    "不采用这次结果"；没有落库/采纳流程（那是下一块）；没有并发控制（同一时刻只该有一个专题在生成 ✓）。

import { filterClaims, extractRefs, uniqueRefs, type SummarizeFn, type SummarySource } from "./librarySummary";
import type { MapSection } from "./libraryMap";

/** 页脚必须出现的串（判据用：每页都要有 ✓）。 */
export const DRAFT_FOOTER = "派生，非出处";

/** 选中的材料一条都没有时，正文就写这一句 —— **不许留空**，也不许编内容 ✓ */
export const NO_MATERIAL_TEXT = "材料不足：未知";

/** 覆盖度读数的形状：`null` ＝ 没有读数（⇒ 写「未知」）✓ */
export interface TopicCoverage {
  indexed: number;
  total: number;
}

export interface TopicDraft {
  /** 给人看的标题（取自分区 label） */
  title: string;
  /** 正文：只含**保留下来的**结论行（回链全来自输入 ✓） */
  body: string;
  /** 正文里实际出现的回链（去重；**每个都在输入里出现过** ✓） */
  refs: string[];
  /** 模型编造的回链条数（> 0 说明模型不老实，但**结果已经被过滤掉了** ✓） */
  droppedInventedRefs: number;
  /** 有结论但没带任何回链、被丢掉的条数 ✓ */
  droppedUnreferenced: number;
  /** 覆盖度说明（**没有读数就是「未知」** ✓） */
  coverage: string;
  /** 页脚：`派生，非出处 ｜ 模型：… ｜ 生成于：…` */
  footer: string;
  model: string;
  /** ISO 时间戳（可注入，便于判据） */
  generatedAt: string;
  /** 这次喂给模型的材料条数 */
  materialCount: number;
  /** 这一次是否真的调了模型（没材料 ⇒ false ⇒ 省一次调用 ✓） */
  calledModel: boolean;
}

/** 允许被引用的回链集合（去重、去空串 ✓）。 */
export function allowedRefsOf(sources: readonly SummarySource[]): string[] {
  return uniqueRefs(sources.map((s) => s.ref).filter((r): r is string => typeof r === "string" && r.length > 0));
}

/** 覆盖度那一句：**没有读数 ⇒ 「未知」**（不许写成 0 / 0，也不许留空 ✓）。 */
export function coverageNoteOf(coverage: TopicCoverage | null | undefined): string {
  if (!coverage || !Number.isFinite(coverage.total) || coverage.total <= 0) return "覆盖度：未知";
  const indexed = Number.isFinite(coverage.indexed) ? coverage.indexed : 0;
  return `覆盖度：${indexed}/${coverage.total}`;
}

/** 提示词（纯函数，便于判据）：把"只能引用这些"和"每条结论都要带回链"说清楚 ✓。 */
export function buildTopicPrompt(section: MapSection, sources: readonly SummarySource[], allowed: readonly string[]): string {
  const material = sources
    .map((s, i) => `【${i + 1}】回链：${s.ref}${s.label ? `（${s.label}）` : ""}\n${s.text}`)
    .join("\n\n");
  return [
    `请为「${section.label}」这个专题写一页简明结论。`,
    "",
    "硬要求（违反的整行会被丢弃）：",
    "1) 每一行结论都必须以回链开头，形如 `[回链] 结论`；",
    `2) 回链**只能**从下面这份清单里取（清单外的一律不许出现）：${allowed.join("、") || "（空）"}；`,
    "3) 材料不足以支撑结论时，直接写「未知」，**不许编造**；",
    "4) 不要写前言后记，只写结论行。",
    "",
    "材料：",
    material,
  ].join("\n");
}

export interface GenerateTopicDraftDeps {
  /** 注入口（测试用假函数；产品里用 `summarizerFromTransport` 包出来的那个 ✓） */
  summarize: SummarizeFn;
  model: string;
  coverage?: TopicCoverage | null;
  /** 注入时间，便于判据逐字比对 ✓ */
  now?: () => Date;
}

/**
 * 生成一页**草稿**（无副作用 ✓）：材料为空 ⇒ **不调模型**，正文写 `材料不足：未知` ✓。
 * 有材料 ⇒ 调模型，然后用既有校验把回链收紧到输入范围内 ✓。
 */
export async function generateTopicDraft(
  section: MapSection,
  sources: readonly SummarySource[],
  deps: GenerateTopicDraftDeps,
): Promise<TopicDraft> {
  const allowed = allowedRefsOf(sources);
  const at = (deps.now ?? (() => new Date()))().toISOString();
  const footer = `${DRAFT_FOOTER} ｜ 模型：${deps.model} ｜ 生成于：${at}`;
  const coverage = coverageNoteOf(deps.coverage);

  if (sources.length === 0 || allowed.length === 0) {
    return {
      title: section.label,
      body: NO_MATERIAL_TEXT,
      refs: [],
      droppedInventedRefs: 0,
      droppedUnreferenced: 0,
      coverage,
      footer,
      model: deps.model,
      generatedAt: at,
      materialCount: sources.length,
      calledModel: false,
    };
  }

  const answer = await deps.summarize(buildTopicPrompt(section, sources, allowed));
  // ⭐ 承重的三行：**既有**的校验器（不是本文件自己写的字符串比较 ✓）
  //    ⚠️ `filterClaims().kept` 是**逐行的 `string[]`**（不是一整段文本）—— 我第一版当成字符串，被 tsc 与判据当场拦下 ✓
  const filtered = filterClaims(answer, allowed);
  const keptText = filtered.kept.join("\n");
  const refs = uniqueRefs(extractRefs(keptText));

  return {
    title: section.label,
    body: keptText.trim().length > 0 ? keptText.trim() : NO_MATERIAL_TEXT,
    refs,
    droppedInventedRefs: filtered.droppedInventedRefs,
    droppedUnreferenced: filtered.droppedUnreferenced,
    coverage,
    footer,
    model: deps.model,
    generatedAt: at,
    materialCount: sources.length,
    calledModel: true,
  };
}
