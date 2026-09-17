// 共用夹具的**一致性跑器** —— 契约见 docs/plans/2026-09-17-knowledge-base-ai-coverage-plan.md §15.6 / §12.5。
//
// 这个文件的价值不在"又多测了几条"，而在于它把**分家后的三份实现钉在同一组期望上**：
// 任何人新增一个抽取器，都必须同时补一条夹具；任何夹具的目标抽取器一旦实现，
// 就会自动从不跑变成跑。**不需要谁记得去改开关。**

import { describe, expect, it } from "vitest";

import { FIXTURES, fixturesFor } from "./fixtures";
import { pickExtractor, REGISTRY } from "./registry";

describe("共用夹具集 · 一致性（这些是「防漂移」护栏，不是内容断言）", () => {
  it("夹具 id 唯一", () => {
    const ids = FIXTURES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("每条夹具的目标抽取器：**要么已注册，要么显式标了 planned**（不许有漏标记的孤儿夹具）", () => {
    const missing = FIXTURES.filter(
      (f) => !REGISTRY.some((e) => e.id === f.extractor) && !f.planned,
    ).map((f) => f.id);
    expect(missing).toEqual([]);
  });

  it("**已注册的抽取器不许还标 planned**（实现落地了就该去掉标记，否则它永远不跑）", () => {
    const stale = FIXTURES.filter(
      (f) => f.planned && REGISTRY.some((e) => e.id === f.extractor),
    ).map((f) => f.id);
    expect(stale).toEqual([]);
  });

  it("**每个已注册的抽取器至少有一条夹具**（新增抽取器不能不带 conformance 夹具）", () => {
    const bare = REGISTRY.filter((e) => fixturesFor(e.id).length === 0).map((e) => e.id);
    expect(bare).toEqual([]);
  });

  it("路由：每个**已实现**夹具的 (mime, filename) 必须被 pickExtractor 路由到它声明的抽取器", () => {
    const wrong: string[] = [];
    for (const f of FIXTURES) {
      if (f.planned) continue;
      const picked = pickExtractor(f.mime, f.filename, REGISTRY);
      if (picked?.id !== f.extractor) {
        wrong.push(`${f.id}: 期望 ${f.extractor}，实际 ${picked?.id ?? "null"}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});

describe("共用夹具集 · 逐条跑已实现的夹具", () => {
  const runnable = FIXTURES.filter((f) => !f.planned);

  it("确实有夹具在跑（防止筛条件写错导致整组静默跳过）", () => {
    expect(runnable.length).toBeGreaterThan(0);
  });

  for (const f of runnable) {
    it(`${f.id} —— ${f.pins}`, async () => {
      const ex = REGISTRY.find((e) => e.id === f.extractor);
      expect(ex, `夹具声明的抽取器 ${f.extractor} 不在注册表里`).toBeDefined();
      if (!ex) return;

      // 夹具**默认不注入 deps**：这样 `image.ocr@1` 会走 provider_error 那条路，
      // 正好把"默认不出网"在夹具层面也钉住；要覆盖 gpu 的成功路径就显式给 `deps.vision`。
      const r = await ex.extract({
        bytes: f.make(),
        filename: f.filename,
        mime: f.mime,
        hash: "fixture",
        deps: f.deps ?? {},
      });

      if (f.expect.ok) {
        expect(r.ok, `期望成功，实际 ${r.ok ? "" : r.code + "：" + r.message}`).toBe(true);
        if (!r.ok) return;
        expect(r.segments.map((s) => s.kind)).toEqual([...f.expect.kinds]);
        const joined = r.segments.map((s) => s.text).join("\n");
        for (const needle of f.expect.contains) expect(joined).toContain(needle);
        if (f.expect.locs) expect(r.segments.map((s) => s.loc)).toEqual([...f.expect.locs]);
      } else {
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.code).toBe(f.expect.code);
      }
    });
  }
});
