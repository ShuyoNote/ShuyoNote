// LLM wiki 的**第一块着陆点**：把**已有的覆盖度报告**重排成一张可浏览的「库地图」。
//
// ## 为什么先做这一块（而不是先做界面、也不是先接模型）
// 1. **零模型调用** ⇒ 没有幻觉风险、没有 token 成本 ⇒ 不需要等 §8 那条"模型成本"的 go/no-go 量测；
// 2. 它输出的每一格都**来自输入**（`CoverageReport`）⇒ "回链不编造"是可判的；
// 3. 它是**纯函数** ⇒ "生成地图不改任何用户数据"（只读默认）也可判 —— 冻结输入就能证；
// 4. 顺带补上面板侧「消费抽取结果」那条老缺口的**第一个用例**。
//
// ## 两条口径直接沿用既有的（不在这儿另立说法）
// · **未知 ≠ 完整 / 未知 ≠ 0**：`count: number | null`，`null` **只**表示"没读数"
//   （与 `CoverageReport.pages.stale` 的 `number | null` 同形，也与 §15.10 那条同一处置）；
// · **截断必须说出来**：明细超过上限 ⇒ `truncated` 为真，并且 `gapsShown` / `gapsTotal` 都要给
//   （"少给几条"与"只有几条"必须分得开）。
//
// ⚠️ **本文件只做"重排 + 计数"**：不生成正文、不调用模型、不 import 平台/接口/存储。
//    "专题分区 + 结论"那一层（效果图里的 人物/项目/概念）需要模型 ⇒ 属**第二块**，不在这里。

import type { CoverageGap, CoverageReport, GapReason } from "../extract/coverageReport";

/** 一格的读数状态：`ok` 有 / `partial` 抽了但没抽全 / `missing` 没进检索面 / `unknown` 没读数。 */
export type MapTone = "ok" | "partial" | "missing" | "unknown";

export interface MapItem {
  /** 稳定 id（`byReason` 的 key、或 `kind:id`）—— **改文案不许改 id**。 */
  key: string;
  label: string;
  /** ⚠️ `null` ＝ **没读数**（不是 0，也不是"没有"）。这条由测试钉住。 */
  count: number | null;
  tone: MapTone;
  /** 给人看的一句话（"该怎么办"）—— 来自输入的 `detail`，没有就给空串。 */
  note: string;
  /** **来源回链**：只允许是输入里出现过的 id —— 由测试钉住（这条就是 `INV-WIKI-provenance`）。 */
  sources: string[];
}

export interface MapSection {
  key: string;
  label: string;
  /** 这一节的摘要句（要能单独读懂；`能搜到 ≠ 抽全了` 这类限定语必须进摘要）。 */
  summary: string;
  items: MapItem[];
}

export interface LibraryMap {
  sections: MapSection[];
  /** 明细展示了几条 / 一共几条 ⇒ `truncated` 见下。**不许静默截断**。 */
  gapsShown: number;
  gapsTotal: number;
  truncated: boolean;
  /** 每一格都有读数吗？有 `unknown` 项 ⇒ `false`（界面据此显示"未知"，不许显示"完整"）。 */
  coverageComplete: boolean;
}

/** 明细默认展示上限。与 `COVERAGE_GAP_LIMIT` 同值但**用途不同**：那个给模型，这个给界面。 */
export const MAP_GAP_LIMIT = 20;

/** 短标签（**长解释在 `coverageReport.ts` 的 `DETAIL` 里**，这里只做一行标题，不复制长句）。 */
const REASON_LABEL: Record<GapReason, string> = {
  no_extractor: "没有抽取器认领这种格式",
  no_content: "抽取器认领了，但抽出来是空的",
  not_chunked: "有文本，但没进块",
  page_empty: "页面在检索面没内容",
  partial: "抽取器自报没抽全",
  text_stale: "派生落后（合并后待重建）",
};

/** 没进检索面的四类（顺序固定 ⇒ 地图稳定；`partial` / `text_stale` 不在此列，它们"进得去"）。 */
const NOT_INDEXED_ORDER: GapReason[] = ["no_extractor", "no_content", "not_chunked", "page_empty"];

/** 由一条明细造一格回链（`sources` 只放**输入里那个 id** —— 不许拼、不许猜）。 */
function gapItem(g: CoverageGap): MapItem {
  return {
    key: `${g.kind}:${g.id}`,
    label: g.id,
    count: 1,
    tone: g.reason === "partial" || g.reason === "text_stale" ? "partial" : "missing",
    note: g.detail,
    sources: [g.id],
  };
}

/**
 * 把覆盖度报告重排成库地图。
 *
 * **只读**：不改输入（调用方可以把它冻住来证明这点），也不读任何外部状态。
 */
export function buildLibraryMap(report: CoverageReport, opts: { gapLimit?: number } = {}): LibraryMap {
  const limit = Math.max(0, Math.floor(opts.gapLimit ?? MAP_GAP_LIMIT) || 0);
  const shown = report.gaps.slice(0, limit);
  const gapsTotal = report.gaps.length;
  const truncated = gapsTotal > shown.length;

  const stale = report.pages.stale;
  // ⚠️ **不是数字 ⇒ 一律按「没读数」**：`number|null` 之外的形态（老数据、夹具漏写）不许被静默漏掉 ——
  //    漏掉会让"这一格"从地图里消失，比显示成 0 更坏（消失＝没人会去补）。
  const staleKnown = typeof stale === "number";

  // ① 进了检索面（能搜到 —— ⚠️ 这一节**只说"搜得到"**，"抽全了吗"在下一节）
  const indexed: MapItem[] = [
    {
      key: "pages.indexed",
      label: "页面有块（搜得到）",
      count: report.pages.indexed,
      tone: "ok",
      note: `共 ${report.pages.total} 页`,
      sources: [],
    },
    {
      key: "attachments.indexed",
      label: "附件已进检索面（搜得到）",
      count: report.attachments.indexed,
      tone: "ok",
      note: `共 ${report.attachments.total} 个附件`,
      sources: [],
    },
  ];

  // ② 抽到了，但不算完整（两个"进得去但不算全"的口径并列）
  const incomplete: MapItem[] = [
    {
      key: "attachments.partial",
      label: "附件没抽全",
      count: report.attachments.partial,
      tone: "partial",
      note: "抽取器自己报了缺口（如混合 PDF 只抽到正文页）—— **搜得到，但没抽全**",
      sources: shown.filter((g) => g.reason === "partial").map((g) => g.id),
    },
  ];
  if (staleKnown) {
    incomplete.push({
      key: "pages.stale",
      label: "页面派生落后",
      count: stale,
      tone: stale > 0 ? "partial" : "ok",
      note: "合并之后派生文本还没重建 ⇒ 搜得到，但搜到的是**旧**内容",
      sources: shown.filter((g) => g.reason === "text_stale").map((g) => g.id),
    });
  }

  // ③ 没进检索面（四类，全列出来 —— 0 也是**读数**，与 ④ 的 `null` 不是一回事）
  const byReason = report.attachments.byReason ?? {};
  const missing: MapItem[] = NOT_INDEXED_ORDER.map((reason) => ({
    key: `byReason.${reason}`,
    label: REASON_LABEL[reason],
    count: byReason[reason] ?? 0,
    tone: (byReason[reason] ?? 0) > 0 ? "missing" : "ok",
    note: "",
    sources: shown.filter((g) => g.reason === reason).map((g) => g.id),
  }));

  const sections: MapSection[] = [
    {
      key: "indexed",
      label: "一、进了检索面",
      summary: `能搜到：页面 ${report.pages.indexed}/${report.pages.total}、附件 ${report.attachments.indexed}/${report.attachments.total}。**能搜到不等于抽全了**（见第二节）。`,
      items: indexed,
    },
    {
      key: "incomplete",
      label: "二、抽到了，但不算完整",
      summary: `没抽全的附件 ${report.attachments.partial} 个；派生落后的页面 ${staleKnown ? stale : "未知"} 页。`,
      items: incomplete,
    },
    {
      key: "missing",
      label: "三、没进检索面",
      summary: `没进检索面共 ${report.attachments.notIndexed} 个附件（按原因分类，0 也是读数）。`,
      items: missing,
    },
  ];

  // ④ 没读数的那一格**单列一节**：不许并进任何数字里（未知 ≠ 0）
  if (!staleKnown) {
    sections.push({
      key: "unknown",
      label: "四、这次没查（未知）",
      summary: "「派生是否落后」这一格这次没查 —— **不许当 0**（未知 ≠ 没有）。",
      items: [
        {
          key: "pages.stale",
          label: "页面派生落后",
          count: null,
          tone: "unknown",
          note: "取材层没给清单，或取不到 ⇒ 这一格是「不知道」，不是「没有」",
          sources: [],
        },
      ],
    });
  }

  // ⑤ 来源明细（前 N 条 + 明说截断）
  sections.push({
    key: "sources",
    label: "五、来源明细（回链）",
    summary: truncated
      ? `列了前 ${shown.length} 条，共 ${gapsTotal} 条 —— **明细被截断了**（不是只有这几条）。`
      : `全部 ${gapsTotal} 条都在这里。`,
    items: shown.map(gapItem),
  });

  const coverageComplete = !sections.some((s) => s.items.some((it) => it.tone === "unknown" || it.count === null));

  return { sections, gapsShown: shown.length, gapsTotal, truncated, coverageComplete };
}
