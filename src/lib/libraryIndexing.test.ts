// 「开始索引」运行模型的判据（不装 DOM：这一层是纯逻辑）。
//
// 守三件事：
//   1. **平台不支持时不给按钮的理由**（`indexAvailability`）——"界面不许承诺做不到的事"；
//   2. **进度映射**（`done/total/label → ratio`）：单调、不越界、终态是 1（进度条画歪了没人看得出来）；
//   3. **摘要把失败单独说出来**：`indexLibrary` 的不变量是"一页失败不停整个库"，
//      所以"跑完了"≠"全都成了" —— 只显示"完成"会让用户以为没有坏页。

import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: { stores: unknown; opts: unknown }[] = [];
vi.mock("./indexPage", () => ({
  indexLibrary: async (stores: unknown, opts: unknown) => {
    calls.push({ stores, opts });
    const onProgress = (opts as { onProgress?: (d: number, t: number, l: string) => void }).onProgress;
    onProgress?.(0, 3, "页面 p1");
    onProgress?.(1, 3, "页面 p2");
    onProgress?.(2, 3, "未整理附件");
    onProgress?.(3, 3, "完成");
    return {
      pages: { total: 2, ok: 2, failed: 0 },
      attachments: { total: 1, searchable: 1, byStatus: {} },
      chunks: { total: 5 },
      unfiled: { attachments: [] },
      failures: [],
      summary: "索引完成：2 页 / 附件 1 个（可检索 1）/ 块 5",
    };
  },
}));

import { formatIndexSummary, indexAvailability, runLibraryIndex, type IndexProgress } from "./libraryIndexing";
import type { Platform } from "./platform/types";

const platformWith = (stores?: unknown): Platform =>
  ({
    executor: { invoke: async () => undefined },
    ...(stores === undefined ? {} : { derivedStores: () => stores as never }),
  }) as unknown as Platform;

const fakeStores = { text: {}, chunks: {} };

describe("indexAvailability：不支持时要有**能显示的理由**", () => {
  it("平台没有 derivedStores ⇒ supported:false + 一句人话", () => {
    const a = indexAvailability(platformWith());
    expect(a.supported).toBe(false);
    if (!a.supported) expect(a.reason).toMatch(/没有派生文本层的写入通道/);
  });

  it("平台有 derivedStores ⇒ supported:true", () => {
    expect(indexAvailability(platformWith(fakeStores))).toEqual({ supported: true });
  });
});

describe("runLibraryIndex", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("平台不支持 ⇒ `{ok:false, reason}`，**且一次进度都不发**（半截进度条比没有更糟）", async () => {
    const seen: IndexProgress[] = [];
    const r = await runLibraryIndex({ platform: platformWith(), onProgress: (p) => seen.push(p) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/写入通道/);
    expect(seen).toEqual([]);
  });

  it("支持的平台 ⇒ 把平台的 store 交给 indexLibrary，并把进度映射成 0..1 的 ratio", async () => {
    const seen: IndexProgress[] = [];
    const r = await runLibraryIndex({ platform: platformWith(fakeStores), onProgress: (p) => seen.push(p) });

    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].stores).toBe(fakeStores); // 用的就是平台装配出来的那对 store
    expect(seen.map((p) => p.done)).toEqual([0, 1, 2, 3]);
    expect(seen.every((p) => p.ratio >= 0 && p.ratio <= 1)).toBe(true);
    // 单调不减，终态 ratio = 1
    for (let i = 1; i < seen.length; i++) expect(seen[i].ratio).toBeGreaterThanOrEqual(seen[i - 1].ratio);
    expect(seen[seen.length - 1].ratio).toBe(1);
    expect(seen[seen.length - 1].label).toBe("完成");
    if (r.ok) expect(r.summary).toContain("索引完成");
  });

  it("total=0（空库）⇒ ratio 是 0 而不是 NaN", async () => {
    vi.resetModules();
    vi.doMock("./indexPage", () => ({
      indexLibrary: async (_s: unknown, opts: unknown) => {
        (opts as { onProgress?: (d: number, t: number, l: string) => void }).onProgress?.(0, 0, "完成");
        return {
          pages: { total: 0, ok: 0, failed: 0 },
          attachments: { total: 0, searchable: 0, byStatus: {} },
          chunks: { total: 0 },
          unfiled: { attachments: [] },
          failures: [],
          summary: "索引完成：库里没有可索引的内容",
        };
      },
    }));
    const mod = await import("./libraryIndexing");
    const seen: IndexProgress[] = [];
    await mod.runLibraryIndex({ platform: platformWith(fakeStores), onProgress: (p) => seen.push(p) });
    expect(seen[0].ratio).toBe(0);
    expect(Number.isNaN(seen[0].ratio)).toBe(false);
  });
});

describe("formatIndexSummary：失败要单独说出来", () => {
  const report = (failures: { kind: "page" | "attachment"; id: string; reason: string }[]) =>
    ({
      pages: { total: 1, ok: 1, failed: failures.length },
      attachments: { total: 0, searchable: 0, byStatus: {} },
      chunks: { total: 3 },
      unfiled: { attachments: [] },
      failures,
      summary: "索引完成：1 页 / 附件 0 个（可检索 0）/ 块 3",
    }) as never;

  it("没有失败 ⇒ 就是底层摘要", () => {
    expect(formatIndexSummary(report([]))).toBe("索引完成：1 页 / 附件 0 个（可检索 0）/ 块 3");
  });

  it("有失败 ⇒ 摘要后面接上条数与明细（前 3 条 + 更多）", () => {
    const s = formatIndexSummary(
      report([
        { kind: "page", id: "p1", reason: "boom" },
        { kind: "attachment", id: "a1", reason: "internal" },
        { kind: "attachment", id: "a2", reason: "no_extractor" },
        { kind: "attachment", id: "a3", reason: "internal" },
        { kind: "attachment", id: "a4", reason: "internal" },
      ]),
    );
    expect(s).toContain("另有 5 条没成");
    expect(s).toContain("页面 p1（boom）");
    expect(s).toContain("附件 a2（no_extractor）");
    expect(s).toContain("等 5 条");
    expect(s).not.toContain("a4"); // 只列前 3 条
  });
});
