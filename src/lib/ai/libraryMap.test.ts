// LLM wiki 第一块着陆点的**三条不变式**断言 —— 每条都**带反例**：
// 正例绿不算数，得证明"该红的样子"确实与正例判得出差别。
//
// 对应的规格条目（`docs/specs/2026-09-28-llm-wiki-spec.md` §1，第四列现在全是 `❌ 无`）：
//   `INV-WIKI-provenance`        回链只来自输入 + 截断必须说出来
//   `INV-WIKI-coverage-visible`  未知 ≠ 0，也 ≠ 完整
//   `INV-WIKI-readonly-default`  纯函数：不改输入、不 import 平台/接口/存储
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { buildLibraryMap, MAP_GAP_LIMIT, type LibraryMap } from "./libraryMap";
import type { CoverageGap, CoverageReport } from "../extract/coverageReport";

const HERE = dirname(fileURLToPath(import.meta.url));

function makeReport(over: {
  gaps?: CoverageGap[];
  stale?: number | null;
  partial?: number;
  notIndexed?: number;
  byReason?: Record<string, number>;
} = {}): CoverageReport {
  return {
    pages: { total: 10, indexed: 8, empty: 2, stale: over.stale === undefined ? 0 : over.stale },
    attachments: {
      total: 5,
      extracted: 4,
      indexed: 3,
      partial: over.partial ?? 1,
      notIndexed: over.notIndexed ?? 2,
      byReason: over.byReason ?? { no_extractor: 1, no_content: 1 },
    },
    derived: { extractors: 3, segments: 40, chars: 12000 },
    chunks: { total: 55 },
    gaps: over.gaps ?? [],
  };
}

function gap(id: string, reason: CoverageGap["reason"], kind: CoverageGap["kind"] = "attachment"): CoverageGap {
  return { kind, id, reason, detail: `${id} 该怎么办` };
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object") {
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

function allItems(m: LibraryMap) {
  return m.sections.flatMap((s) => s.items);
}

describe("INV-WIKI-provenance —— 回链只来自输入，且截断必须说出来", () => {
  it("每个 sources 都必须在输入里出现过（不许拼、不许猜）", () => {
    const gaps = [gap("att-1", "no_extractor"), gap("page-2", "partial", "page"), gap("att-3", "no_content")];
    const m = buildLibraryMap(makeReport({ gaps }));
    const inputIds = new Set(gaps.map((g) => g.id));
    const sources = allItems(m).flatMap((it) => it.sources);
    expect(sources.length).toBeGreaterThan(0);
    for (const s of sources) expect(inputIds.has(s)).toBe(true);
  });

  it("来源明细的条数 = “展示了几条”，且展示多少要与“一共几条”分得开", () => {
    const gaps = Array.from({ length: 25 }, (_, i) => gap(`att-${i}`, "no_content"));
    const m = buildLibraryMap(makeReport({ gaps }), { gapLimit: 20 });
    expect(m.gapsTotal).toBe(25);
    expect(m.gapsShown).toBe(20);
    expect(m.truncated).toBe(true);
    const sources = m.sections.find((s) => s.key === "sources")!;
    expect(sources.items).toHaveLength(20);
    // ⚠️ 两个数字都要出现在那句话里：只说"20 条"就是静默截断
    expect(sources.summary).toContain("20");
    expect(sources.summary).toContain("25");
    expect(sources.summary).toContain("截断");
  });

  it("反例：没超过上限 ⇒ 不许说“截断”", () => {
    const gaps = Array.from({ length: 3 }, (_, i) => gap(`att-${i}`, "no_content"));
    const m = buildLibraryMap(makeReport({ gaps }));
    expect(m.truncated).toBe(false);
    expect(m.gapsTotal).toBe(3);
    expect(m.sections.find((s) => s.key === "sources")!.summary).not.toContain("截断");
  });

  it("不给上限 ⇒ 用默认值（`MAP_GAP_LIMIT`），并照样明说截断", () => {
    const gaps = Array.from({ length: MAP_GAP_LIMIT + 5 }, (_, i) => gap(`att-${i}`, "no_content"));
    const m = buildLibraryMap(makeReport({ gaps }));
    expect(m.gapsShown).toBe(MAP_GAP_LIMIT);
    expect(m.gapsTotal).toBe(MAP_GAP_LIMIT + 5);
    expect(m.truncated).toBe(true);
  });

  it("地图结构稳定：section 的 key 与顺序固定（改文案不许改 id）", () => {
    const a = buildLibraryMap(makeReport({ stale: 0 })).sections.map((s) => s.key);
    const b = buildLibraryMap(makeReport({ stale: null })).sections.map((s) => s.key);
    expect(a).toEqual(["indexed", "incomplete", "missing", "sources"]);
    expect(b).toEqual(["indexed", "incomplete", "missing", "unknown", "sources"]);
  });
});

describe("INV-WIKI-coverage-visible —— 未知 ≠ 0，也 ≠ 完整", () => {
  it("① 没查（`stale === null`）⇒ 单列一节，`count === null`、tone=unknown，且整体不算完整", () => {
    const m = buildLibraryMap(makeReport({ stale: null }));
    const unknown = allItems(m).filter((it) => it.tone === "unknown");
    expect(unknown).toHaveLength(1);
    expect(unknown[0].key).toBe("pages.stale");
    expect(unknown[0].count).toBeNull();
    expect(m.coverageComplete).toBe(false);
    expect(m.sections.find((s) => s.key === "unknown")!.summary).toContain("不许当 0");
  });

  it("② 查过了、没有落后（`stale === 0`）⇒ 是**读数 0**，不是未知", () => {
    const m = buildLibraryMap(makeReport({ stale: 0 }));
    expect(m.sections.some((s) => s.key === "unknown")).toBe(false);
    const it0 = allItems(m).find((it) => it.key === "pages.stale")!;
    expect(it0.count).toBe(0);
    expect(it0.tone).toBe("ok");
    expect(m.coverageComplete).toBe(true);
  });

  it("③ ★ 两者必须判得出差别：`null` 与 `0` 的 count 不是一回事", () => {
    const unknown = allItems(buildLibraryMap(makeReport({ stale: null }))).find((it) => it.key === "pages.stale")!;
    const zero = allItems(buildLibraryMap(makeReport({ stale: 0 }))).find((it) => it.key === "pages.stale")!;
    expect(unknown.count).toBeNull();
    expect(zero.count).toBe(0);
    expect(unknown.count).not.toBe(zero.count);
    expect(unknown.tone).not.toBe(zero.tone);
  });

  it("③′ 不是数字（老数据 / 夹具漏写）⇒ 也按**未知**，不许被静默漏掉", () => {
    const r = makeReport();
    delete (r.pages as { stale?: unknown }).stale;
    const m = buildLibraryMap(r);
    const it0 = allItems(m).find((it) => it.key === "pages.stale")!;
    expect(it0, "这一格不该从地图里消失").toBeTruthy();
    expect(it0.count).toBeNull();
    expect(it0.tone).toBe("unknown");
    expect(m.coverageComplete).toBe(false);
  });

  it("④ 没进检索面的四类全列出来，`0` 是读数（不是「没有这一格」）", () => {
    const m = buildLibraryMap(makeReport({ byReason: { no_extractor: 2 } }));
    const keys = allItems(m).map((it) => it.key);
    for (const r of ["no_extractor", "no_content", "not_chunked", "page_empty"]) {
      expect(keys).toContain(`byReason.${r}`);
    }
    const zero = allItems(m).find((it) => it.key === "byReason.no_content")!;
    expect(zero.count).toBe(0);
    expect(zero.count).not.toBeNull();
  });
});

describe("INV-WIKI-readonly-default —— 纯函数：不改输入、不碰平台", () => {
  it("输入被深冻结也能跑完（说明它不写输入），且两次调用结果深度相等", () => {
    const frozen = deepFreeze(makeReport({ gaps: [gap("att-1", "partial")], stale: null }));
    const a = buildLibraryMap(frozen);
    const b = buildLibraryMap(frozen);
    expect(a).toEqual(b);
  });

  it("调用前后输入逐字段未变（快照比对）", () => {
    const r = makeReport({ gaps: [gap("att-1", "text_stale", "page")], stale: 2 });
    const before = JSON.stringify(r);
    buildLibraryMap(r);
    expect(JSON.stringify(r)).toBe(before);
  });

  it("★ 静态：模块不许 import 平台 / 接口 / 存储（纯逻辑，不产生 I/O）", () => {
    const src = readFileSync(join(HERE, "libraryMap.ts"), "utf8");
    for (const bad of ['from "../api"', 'from "./api"', 'from "../platform', 'from "../store', 'from "./store']) {
      expect(src.includes(bad)).toBe(false);
    }
    expect(src.includes("await ")).toBe(false);
  });
});
