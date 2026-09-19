// P4 取材层的判据（不装 DOM：这一层是纯逻辑；`api` 用 mock，平台用假 store）。
//
// 守四件事：
//   1. **回链的形状与页码口径**：PDF 的 `p.<n>`（1 基）必须换成 `pdf://att#n-1`（0 基）
//      —— 差一个就是"点回链跳到隔壁页"，而这种错在界面上看不出异常；
//   2. **★ 发出去的每个回链都必须能被 `extractRefs` 认出来**：认不出 ⇒ 模型照抄也会被判
//      "没出处"整行丢掉 ⇒ 整批结论全灭（这是本模块最容易漏、又最难查的坑）；
//   3. **没索引 / 超预算 / 标题不可用 ⇒ 如实进 `skipped`**（不许静默少一段）；
//   4. 取材是**确定顺序**且同一附件只算一次（回链顺序稳定、内容不翻倍）。

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api", () => ({
  api: {
    listPages: vi.fn(),
    getPage: vi.fn(),
    listPageAttachments: vi.fn(),
  },
}));

import { api } from "../api";
import type { Chunk } from "../extract/chunk";
import type { Platform } from "../platform/types";
import { extractRefs } from "./librarySummary";
import {
  collectSummarySources,
  formatSummaryNote,
  isCitable,
  pageNumberOf,
  pageRefOf,
  runLibrarySummary,
  summaryDraft,
  summaryDraftEntry,
  type CollectSummarySourcesOptions,
} from "./librarySummaryRun";

const chunk = (o: Partial<Chunk> & { text: string }): Chunk => ({
  id: o.id ?? `c-${o.text.slice(0, 4)}`,
  pageId: o.pageId ?? null,
  attId: o.attId ?? null,
  ord: o.ord ?? 0,
  loc: o.loc ?? "",
  lang: o.lang ?? "",
  text: o.text,
  hash: o.hash ?? "h",
});

/** 假平台：`chunksOf(owner)` 按 owner 键查表；不给 derivedStores 就是"平台不支持"。 */
function platformWith(table: Record<string, Chunk[]>, supported = true): Platform {
  return {
    executor: { invoke: async () => undefined },
    ...(supported
      ? {
          derivedStores: async () => ({
            text: {},
            chunks: {
              chunksOf: async (owner: { kind: string; pageId?: string; attId?: string }) =>
                table[owner.kind === "page" ? `page:${owner.pageId}` : `att:${owner.attId}`] ?? [],
            },
          }),
        }
      : {}),
  } as unknown as Platform;
}

const OPTS = (p: Platform, extra: Partial<CollectSummarySourcesOptions> = {}): CollectSummarySourcesOptions => ({
  platform: p,
  ...extra,
});

beforeEach(() => {
  vi.mocked(api.listPages).mockResolvedValue([] as never);
  vi.mocked(api.getPage).mockResolvedValue(null as never);
  vi.mocked(api.listPageAttachments).mockResolvedValue([] as never);
});

describe("回链与页码口径", () => {
  it("PDF 的 `p.<n>`（1 基）→ 0 基页号；不是页码定位的（`S3!B4`/空）返回 null", () => {
    expect(pageNumberOf("p.1")).toBe(1);
    expect(pageNumberOf(" p.12 ")).toBe(12);
    expect(pageNumberOf("p.0")).toBeNull();
    expect(pageNumberOf("S3!B4")).toBeNull();
    expect(pageNumberOf("")).toBeNull();
  });

  it("标题构成的回链必须能被 extractRefs 认出来；认不出的给 null（空标题 / 含 ]] / 超 120 字）", () => {
    expect(pageRefOf("季度总结")).toBe("[[季度总结]]");
    expect(isCitable(pageRefOf("季度总结")!)).toBe(true);
    expect(pageRefOf("")).toBeNull();
    expect(pageRefOf("坏]标题")).toBeNull();
    expect(pageRefOf("长".repeat(121))).toBeNull();
    expect(pageRefOf("换\n行")).toBeNull();
  });
});

describe("collectSummarySources：取材与回链", () => {
  it("页面：按 chunk 顺序拼正文，回链是 [[标题]]", async () => {
    vi.mocked(api.listPages).mockResolvedValue([{ id: "p1", title: "季度总结" }] as never);
    const p = platformWith({
      "page:p1": [chunk({ pageId: "p1", ord: 0, text: "营收 1200 万" }), chunk({ pageId: "p1", ord: 1, text: "研发 300 万" })],
    });
    const r = await collectSummarySources(OPTS(p));
    expect(r.sources).toHaveLength(1);
    expect(r.sources[0]).toMatchObject({ ref: "[[季度总结]]", kind: "page", label: "季度总结" });
    expect(r.sources[0].text).toBe("营收 1200 万\n\n研发 300 万");
    expect(r).toMatchObject({ pages: 1, attachments: 0, skipped: [] });
  });

  it("★ PDF 附件：**逐页一个来源**，回链页码是 0 基（p.1→#0、p.3→#2 —— 差一个就跳错页）", async () => {
    vi.mocked(api.listPages).mockResolvedValue([{ id: "p1", title: "年报" }] as never);
    vi.mocked(api.listPageAttachments).mockResolvedValue([
      { id: "a1", name: "年报.pdf", mime: "application/pdf", size: 1, hash: "h", path: "" },
    ] as never);
    const p = platformWith({
      "page:p1": [],
      "att:a1": [
        chunk({ attId: "a1", ord: 0, loc: "p.1", text: "第一页文字" }),
        chunk({ attId: "a1", ord: 1, loc: "p.3", text: "第三页文字" }),
        chunk({ attId: "a1", ord: 2, loc: "p.3", text: "第三页后半" }),
      ],
    });
    const r = await collectSummarySources(OPTS(p));
    expect(r.sources.map((s) => s.ref)).toEqual(["pdf://a1#0", "pdf://a1#2"]);
    expect(r.sources.map((s) => s.kind)).toEqual(["pdf-page", "pdf-page"]);
    expect(r.sources[1].text).toBe("第三页文字\n第三页后半");
    // 页面没索引 ⇒ 如实说，不静默少
    expect(r.skipped.map((s) => s.ref)).toEqual(["[[年报]]"]);
  });

  it("非 PDF 附件：整份一个来源，回链 att://<id>", async () => {
    vi.mocked(api.listPages).mockResolvedValue([] as never);
    vi.mocked(api.listPageAttachments).mockResolvedValue([
      { id: "a9", name: "预算.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 1, hash: "h", path: "" },
    ] as never);
    const p = platformWith({ "att:a9": [chunk({ attId: "a9", loc: "S1!A1", text: "差旅 8 万" })] });
    const r = await collectSummarySources(OPTS(p));
    expect(r.sources).toHaveLength(1);
    expect(r.sources[0]).toMatchObject({ ref: "att://a9", kind: "attachment", label: "预算.docx" });
    expect(r).toMatchObject({ pages: 0, attachments: 1 });
  });

  it("PDF 里没有页码定位的段 ⇒ 单独说明（不假装那些字进去了）", async () => {
    vi.mocked(api.listPageAttachments).mockResolvedValue([
      { id: "a1", name: "x.pdf", mime: "application/pdf", size: 1, hash: "h", path: "" },
    ] as never);
    const p = platformWith({
      "att:a1": [chunk({ attId: "a1", loc: "", text: "没页码的段" }), chunk({ attId: "a1", loc: "p.2", text: "第二页" })],
    });
    const r = await collectSummarySources(OPTS(p));
    expect(r.sources.map((s) => s.ref)).toEqual(["pdf://a1#1"]);
    expect(r.skipped.some((s) => /1 段没有页码定位/.test(s.reason))).toBe(true);
  });

  it("★ 未整理附件默认算（includeUnfiled:false 就不算）", async () => {
    vi.mocked(api.listPageAttachments).mockImplementation((async (pageId: string | null) =>
      pageId === null
        ? [{ id: "u1", name: "散的.txt", mime: "text/plain", size: 1, hash: "h", path: "" }]
        : []) as never);
    const p = platformWith({ "att:u1": [chunk({ attId: "u1", text: "未整理的正文" })] });
    expect((await collectSummarySources(OPTS(p))).sources.map((s) => s.ref)).toEqual(["att://u1"]);
    expect((await collectSummarySources(OPTS(p, { includeUnfiled: false }))).sources).toEqual([]);
  });

  it("同一附件挂在两页上 ⇒ 只算一次（否则回链重复、内容翻倍）", async () => {
    vi.mocked(api.listPages).mockResolvedValue([{ id: "p1", title: "甲" }, { id: "p2", title: "乙" }] as never);
    vi.mocked(api.listPageAttachments).mockResolvedValue([
      { id: "a1", name: "共用.pdf", mime: "application/pdf", size: 1, hash: "h", path: "" },
    ] as never);
    const p = platformWith({
      "page:p1": [chunk({ pageId: "p1", text: "甲页正文" })],
      "page:p2": [chunk({ pageId: "p2", text: "乙页正文" })],
      "att:a1": [chunk({ attId: "a1", loc: "p.1", text: "共用第一页" })],
    });
    const r = await collectSummarySources(OPTS(p));
    expect(r.sources.map((s) => s.ref)).toEqual(["[[甲]]", "[[乙]]", "pdf://a1#0"]);
    expect(r.attachments).toBe(1);
  });

  it("显式 pageIds ⇒ 只取那几页；不存在的如实报；重复 id 去重（同一页不出两条来源）", async () => {
    // 按参数回话（不能一律返回同一页，否则测不出"取的是哪几页"）
    vi.mocked(api.getPage).mockImplementation((async (id: string) =>
      id === "p1" ? { id: "p1", title: "甲" } : null) as never);
    const p = platformWith({ "page:p1": [chunk({ pageId: "p1", text: "甲的正文" })] });
    const r = await collectSummarySources(OPTS(p, { pageIds: ["p1", "ghost", "p1"] }));
    expect(r.sources.map((s) => s.ref)).toEqual(["[[甲]]"]);
    expect(r.skipped).toEqual([{ ref: "ghost", reason: "页面不存在（可能已删除）" }]);
  });

  it("★ 超预算 ⇒ 剩下的逐条如实列出，且**送进去的正文一个字都没被切**", async () => {
    vi.mocked(api.listPages).mockResolvedValue([{ id: "p1", title: "甲" }, { id: "p2", title: "乙" }] as never);
    const body = "字".repeat(60);
    const p = platformWith({
      "page:p1": [chunk({ pageId: "p1", text: body })],
      "page:p2": [chunk({ pageId: "p2", text: body })],
    });
    const r = await collectSummarySources(OPTS(p, { maxCharsTotal: 100 }));
    expect(r.sources).toHaveLength(1);
    expect(r.sources[0].text).toBe(body); // 没被截断
    expect(r.chars).toBe(60);
    expect(r.skipped.map((s) => s.ref)).toEqual(["[[乙]]", "(取材范围)"]);
  });

  it("★ 硬性质：**每个发出去的回链都能被 extractRefs 认出来**（认不出 = 模型抄了也会被判没出处）", async () => {
    vi.mocked(api.listPages).mockResolvedValue([{ id: "p1", title: "季度总结" }] as never);
    vi.mocked(api.listPageAttachments).mockResolvedValue([
      { id: "a1", name: "年报.pdf", mime: "application/pdf", size: 1, hash: "h", path: "" },
      { id: "a2", name: "表.xlsx", mime: "application/vnd.ms-excel", size: 1, hash: "h", path: "" },
    ] as never);
    const p = platformWith({
      "page:p1": [chunk({ pageId: "p1", text: "页面正文" })],
      "att:a1": [chunk({ attId: "a1", loc: "p.2", text: "第二页" })],
      "att:a2": [chunk({ attId: "a2", loc: "S1!A1", text: "表格" })],
    });
    const r = await collectSummarySources(OPTS(p));
    expect(r.sources).toHaveLength(3);
    for (const s of r.sources) {
      expect(extractRefs(s.ref), `认不出的回链：${s.ref}`).toContain(s.ref);
    }
  });

  it("平台不支持（没有 derivedStores）⇒ blocked，一条来源都不给（界面据此禁用按钮）", async () => {
    const r = await collectSummarySources(OPTS(platformWith({}, false)));
    expect(r.sources).toEqual([]);
    expect(r.blocked).toMatch(/写入通道|派生文本层/);
  });
});

describe("runLibrarySummary / 摘要人话 / 落块草稿", () => {
  it("成功路径：正文一条条带回链，note 里报清「取材 / 覆盖 / 丢弃 / 没进来」", async () => {
    vi.mocked(api.listPages).mockResolvedValue([{ id: "p1", title: "季度总结" }] as never);
    const p = platformWith({ "page:p1": [chunk({ pageId: "p1", text: "营收 1200 万" })] });
    const r = await runLibrarySummary({
      platform: p,
      summarize: async () => "- 营收 1200 万 [[季度总结]]\n- 没有出处的结论",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.summary.markdown).toContain("营收 1200 万 [[季度总结]]");
    expect(r.summary.markdown).not.toContain("没有出处的结论");
    expect(r.summary.droppedUnreferenced).toBe(1);
    expect(r.note).toContain("取材 1 个来源");
    expect(r.note).toContain("丢弃 1 条结论");
  });

  it("库里没有可总结的内容 ⇒ ok:false + 一句人话（把第一条 skipped 的原因带出来）", async () => {
    vi.mocked(api.listPages).mockResolvedValue([{ id: "p1", title: "空页" }] as never);
    const r = await runLibrarySummary({ platform: platformWith({}), summarize: async () => "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/还没有可总结的内容.*先点「开始索引」/);
  });

  it("平台不支持 ⇒ ok:false，理由是平台那句人话", async () => {
    const r = await runLibrarySummary({ platform: platformWith({}, false), summarize: async () => "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/写入通道|派生文本层/);
  });

  it("formatSummaryNote：没进来的超过 3 条 ⇒ 只列前 3 条 + 「等 N 条」", () => {
    const note = formatSummaryNote(
      {
        markdown: "x",
        refs: ["[[甲]]"],
        batches: [{ refs: ["[[甲]]"], chars: 1, oversize: false, raw: "", kept: [], droppedUnreferenced: 0, droppedInventedRefs: 0 }],
        droppedUnreferenced: 0,
        droppedInventedRefs: 0,
        notFound: false,
      },
      {
        sources: [],
        chars: 0,
        pages: 1,
        attachments: 0,
        skipped: [1, 2, 3, 4, 5].map((i) => ({ ref: `[[${i}]]`, reason: "没索引" })),
      },
    );
    expect(note).toContain("另有 5 条没进来");
    expect(note).toContain("[[1]]");
    expect(note).not.toContain("[[4]]");
    expect(note).toContain("等 5 条");
  });

  it("summaryDraft：有当前页才有草稿（**不替用户挑页面**），空正文不给草稿", () => {
    const s = { markdown: "## 跨库总结\n- 甲 [[甲]]\n", refs: ["[[甲]]"], batches: [], droppedUnreferenced: 0, droppedInventedRefs: 0, notFound: false };
    expect(summaryDraft(s, "p1")).toEqual({ kind: "append_block", pageId: "p1", text: "## 跨库总结\n- 甲 [[甲]]" });
    expect(summaryDraft(s, null)).toBeNull();
    expect(summaryDraft(s, "  ")).toBeNull();
    expect(summaryDraft({ ...s, markdown: "   " }, "p1")).toBeNull();
  });

  it("summaryDraftEntry：信封与 AI 工具面同形（key 同约定 ⇒ 与工具重复追加时按 key 去重）", () => {
    const s = { markdown: "## 跨库总结\n- 甲 [[甲]]\n- 乙 [[乙]]\n", refs: ["[[甲]]"], batches: [], droppedUnreferenced: 0, droppedInventedRefs: 0, notFound: false };
    const e = summaryDraftEntry(s, "p1")!;
    expect(e.key).toBe(`append_block:p1:${s.markdown.trim().slice(0, 24)}`);
    expect(e.summary).toContain("3 个段落");
    expect(e.payload).toEqual({ kind: "append_block", pageId: "p1", text: s.markdown.trim() });
    expect(summaryDraftEntry(s, null)).toBeNull();
  });
});
