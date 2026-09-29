// 「库地图」视图的**渲染级**判据（第二块着陆点）。
//
// 为什么要有它：这一块的"看起来没事、实际很坏"的形状只有一个，但它很致命 ——
// **把「没读数」画成 0**（或反过来把 0 画成"未知"）。那会让用户把"没查"读成"没有"，
// 与 §15.10「成功 ≠ 抽全了」、`pages.stale` 那条界面先例是同一处置。
// 所以这里**成对**断言：`null ⇒ 「未知」且不出现 0` ／ `0 ⇒ 显示 0 且不出现「未知」`。
//
// 挂载方式与本仓其它组件判据一致（`createRoot` + `flushSync`，见 `aiSettingsCoverage.test.tsx`）。

import { afterEach, describe, expect, it } from "vitest";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";

import { LibraryMapView } from "./LibraryMapView";
import { buildLibraryMap } from "../lib/ai/libraryMap";
import type { TopicDraft } from "../lib/ai/topicDraft";
import type { CoverageGap, CoverageReport } from "../lib/extract/coverageReport";

function report(over: { gaps?: CoverageGap[]; stale?: number | null } = {}): CoverageReport {
  return {
    pages: { total: 10, indexed: 8, empty: 2, stale: over.stale === undefined ? 0 : over.stale },
    attachments: {
      total: 4,
      extracted: 3,
      indexed: 2,
      partial: 1,
      notIndexed: 1,
      byReason: { no_extractor: 1, no_content: 0, not_chunked: 0, page_empty: 0 },
    },
    derived: { extractors: 2, segments: 12, chars: 345 },
    chunks: { total: 7 },
    gaps: over.gaps ?? [{ kind: "attachment", id: "a1", reason: "partial", detail: "混合 PDF 只抽到正文页" }],
  };
}

let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLDivElement | null = null;

function mount(r: CoverageReport) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  flushSync(() => root!.render(<LibraryMapView map={buildLibraryMap(r)} />));
  return host;
}

function itemEl(key: string): HTMLElement | null {
  return host!.querySelector(`[data-item="${key}"]`);
}
/** ⚠️ `data-count` 挂在**内层那个 span** 上（`li` 上是 `data-item`）—— 第一版查错了层。 */
function countEl(key: string): HTMLElement | null {
  return host!.querySelector(`[data-item="${key}"] .ai-libmap-item-count`);
}

afterEach(() => {
  if (root) flushSync(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("库地图视图", () => {
  it("★ 没读数（`null`）⇒ 画成「未知」，**且这一项里不出现 0**", () => {
    mount(report({ stale: null }));
    const el = itemEl("pages.stale")!;
    expect(el).toBeTruthy();
    const c = countEl("pages.stale")!;
    expect(c.getAttribute("data-count")).toBe("unknown");
    expect(c.textContent).toContain("未知");
    expect(el.textContent).not.toContain("0");
    expect(host!.textContent).toContain("未知不等于没有");
  });

  it("★ 成对的反例：读数 0 ⇒ 画成 0，**且不出现「未知」**", () => {
    mount(report({ stale: 0 }));
    const el = itemEl("pages.stale")!;
    const c = countEl("pages.stale")!;
    expect(c.getAttribute("data-count")).toBe("0");
    expect(el.textContent).not.toContain("未知");
    expect(host!.textContent).not.toContain("未知不等于没有");
  });

  it("★ 明细被截断 ⇒ 界面上要能看见那句话（不是只有数据层知道）", () => {
    const many: CoverageGap[] = Array.from({ length: 25 }, (_, i) => ({
      kind: "attachment",
      id: `a${i}`,
      reason: "no_content",
      detail: "抽出来是空的",
    }));
    mount(report({ gaps: many }));
    const t = host!.textContent ?? "";
    expect(t).toContain("截断");
    expect(t).toContain("20");
    expect(t).toContain("25");
  });

  it("来源回链要显示出来（`provenance` 的界面那一半）", () => {
    mount(report());
    const t = host!.textContent ?? "";
    expect(t).toContain("a1");
    expect(t).toContain("来源");
  });

  it("三种读法在界面层可分辨（`data-tone`），且明说它不生成正文、不写库", () => {
    mount(report({ stale: null }));
    const tones = new Set([...host!.querySelectorAll("[data-tone]")].map((e) => e.getAttribute("data-tone")));
    expect(tones.has("ok")).toBe(true);
    expect(tones.has("partial")).toBe(true);
    expect(tones.has("missing")).toBe(true);
    expect(tones.has("unknown")).toBe(true);
    expect(host!.textContent).toContain("不生成正文");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 第三块（按需单页）在**界面**这一半的判据。
// 这一层要钉的是"读者不会误以为库被改了"：草稿区必须自称「草稿，未落库」＋ 带页脚「派生，非出处」；
// 且覆盖度**没有读数时不许显示成 0**（与上面那条同源的成对口径 ✓）。
// ─────────────────────────────────────────────────────────────────────────────

function draftOf(over: Partial<TopicDraft> = {}): TopicDraft {
  return {
    title: "专题",
    body: "[[同步总览]] 同步靠变更日志。",
    refs: ["[[同步总览]]"],
    droppedInventedRefs: 0,
    droppedUnreferenced: 0,
    coverage: "覆盖度：3/9",
    footer: "派生，非出处 ｜ 模型：Qwen3:8B ｜ 生成于：2026-09-29T02:00:00.000Z",
    model: "Qwen3:8B",
    generatedAt: "2026-09-29T02:00:00.000Z",
    materialCount: 2,
    calledModel: true,
    ...over,
  };
}

function mountWith(props: Partial<Parameters<typeof LibraryMapView>[0]> = {}, r: CoverageReport = report()) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  flushSync(() => root!.render(<LibraryMapView map={buildLibraryMap(r)} {...props} />));
  return host;
}

describe("库地图视图 · 第三块（生成这一页）", () => {
  it("给了 onGenerate ⇒ 每个分区都有「生成这一页」，点击回调带上**那个分区**", () => {
    const seen: string[] = [];
    mountWith({ onGenerate: (s) => seen.push(s.key) });
    // ⚠️ 不要写死分区 key（它是 `buildLibraryMap` 定的，不是我这个测试定的）—— 取第一个按钮即可 ✓
    const btn = host!.querySelector("[data-gen]") as HTMLButtonElement | null;
    expect(btn).toBeTruthy();
    expect(btn!.getAttribute("data-gen")).toBeTruthy();
    expect(btn!.textContent).toContain("生成这一页");
    flushSync(() => btn!.click());
    expect(seen).toEqual([btn!.getAttribute("data-gen")]);
  });

  it("没给 onGenerate ⇒ **没有**按钮（不接线就不出现，免得点了没反应 ✓）", () => {
    mountWith({});
    expect(host!.querySelector("[data-gen]")).toBeNull();
  });

  it("★ 草稿区必须自称「草稿，未落库」＋ 带页脚「派生，非出处」＋ 回链", () => {
    mountWith({ draft: draftOf() });
    const d = host!.querySelector('[data-testid="topic-draft"]')!;
    expect(d).toBeTruthy();
    expect(host!.querySelector('[data-testid="draft-badge"]')!.textContent).toContain("草稿，未落库");
    expect(host!.querySelector('[data-testid="draft-footer"]')!.textContent).toContain("派生，非出处");
    expect(host!.querySelector('[data-testid="draft-refs"]')!.textContent).toContain("[[同步总览]]");
    expect(host!.textContent).toContain("同步靠变更日志");
  });

  it("★ 覆盖度：没有读数 ⇒ 画「未知」且**不出现 0/**；有读数 ⇒ 画 3/9 且不出现「未知」（成对）", () => {
    mountWith({ draft: draftOf({ coverage: "覆盖度：未知" }) });
    const unknown = host!.querySelector('[data-testid="draft-coverage"]')!;
    expect(unknown.textContent).toContain("未知");
    expect(unknown.textContent).not.toContain("0/");
    flushSync(() => root!.unmount());
    host!.remove();
    mountWith({ draft: draftOf({ coverage: "覆盖度：3/9" }) });
    const known = host!.querySelector('[data-testid="draft-coverage"]')!;
    expect(known.textContent).toBe("覆盖度：3/9");
    expect(known.textContent).not.toContain("未知");
  });

  it("丢了编造的回链 ⇒ 界面上要说出来（不是只有数据层知道 ✓）", () => {
    mountWith({ draft: draftOf({ droppedInventedRefs: 2 }) });
    expect(host!.querySelector('[data-testid="draft-dropped"]')!.textContent).toContain("2");
  });

  it("没给 draft ⇒ 不出现草稿区（默认什么都不显示 ✓）", () => {
    mountWith({});
    expect(host!.querySelector('[data-testid="topic-draft"]')).toBeNull();
  });
});
