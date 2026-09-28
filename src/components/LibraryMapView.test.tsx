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
