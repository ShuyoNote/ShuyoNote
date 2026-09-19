// P4「跨库总结 + 强制回链」的判据。
//
// 这一篇的重心不是"总结得好不好"（那要靠人看），而是**三条可机检的性质**：
//   1. **回链不丢**：输出里出现的每一个回链都必须是输入里有的（不许编造）；
//   2. **没有回链的结论进不来**：模型写得多漂亮，没出处就丢，且**计数回报**；
//   3. **查不到就说查不到**：空库时连模型都不打。
//
// 判据分两层：纯函数各测一遍（`extractRefs` / `filterClaims` / `planBatches`），
// 再用**夹具**（`tests/library-summary-fixtures.json`）端到端验一遍组合行为 ——
// 加场景只改夹具，不改测试代码。

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  extractRefs,
  filterClaims,
  isClaimLine,
  mapReduceSummarize,
  planBatches,
  summarizerFromTransport,
  uniqueRefs,
  type SummarySource,
} from "./librarySummary";

const fx = JSON.parse(readFileSync(join(process.cwd(), "tests", "library-summary-fixtures.json"), "utf8")) as {
  scenarios: {
    id: string;
    sources: SummarySource[];
    scripted: string[];
    expect: {
      markdownContains?: string[];
      markdownNotContains?: string[];
      refs?: string[];
      calls?: number;
      droppedUnreferenced?: number;
      droppedInventedRefs?: number;
      notFound?: boolean;
    };
  }[];
};

/** 脚本化模型：按批号吐预设输出，并记录调用次数与提示词。 */
function scripted(answers: readonly string[]) {
  const calls: string[] = [];
  const fn = async (prompt: string) => {
    const i = calls.length;
    calls.push(prompt);
    return answers[i] ?? "";
  };
  return { fn, calls };
}

describe("回链识别（四种形状，唯一口径）", () => {
  it("页面 / pdf 页 / 附件 / 块 都能认出来，且按出现顺序", () => {
    const text = "先 [[季度总结]] 再 pdf://att-1#2，然后 att://att-9 与 blk-abc123，最后 att://att-9#p.12";
    expect(extractRefs(text)).toEqual([
      "[[季度总结]]",
      "pdf://att-1#2",
      "att://att-9",
      "blk-abc123",
      "att://att-9#p.12",
    ]);
  });

  it("不像回链的东西不许误认（`pdf://x#` 没有页码、`blk-` 后面太短）", () => {
    expect(extractRefs("pdf://x# 与 blk- 与 [[ 没闭合 与 at://nope")).toEqual([]);
  });

  it("去重保序：首次出现的顺序有意义（大致反映材料顺序）", () => {
    expect(uniqueRefs(["b", "a", "b", "c", "a"])).toEqual(["b", "a", "c"]);
  });

  it("标题/空行/水平线不是结论行（允许不带回链）", () => {
    expect(isClaimLine("## 要点")).toBe(false);
    expect(isClaimLine("   ")).toBe(false);
    expect(isClaimLine("---")).toBe(false);
    expect(isClaimLine("- 营收 1200 万 [[季度总结]]")).toBe(true);
  });
});

describe("结论行过滤（强制回链）", () => {
  const allowed = ["[[甲]]", "att://x"];

  it("有回链且回链合法 ⇒ 留下；没有回链 ⇒ 丢并计数", () => {
    const r = filterClaims("- 结论 A [[甲]]\n- 结论 B（没出处）\n## 小标题", allowed);
    expect(r.kept).toEqual(["- 结论 A [[甲]]", "## 小标题"]);
    expect(r.droppedUnreferenced).toBe(1);
    expect(r.droppedInventedRefs).toBe(0);
  });

  it("★ 引用了本批不存在的回链 ⇒ 丢并**单独计数**（编造出处比没有出处更坏）", () => {
    const r = filterClaims("- 结论 A att://y\n- 结论 B att://x", allowed);
    expect(r.kept).toEqual(["- 结论 B att://x"]);
    expect(r.droppedInventedRefs).toBe(1);
    expect(r.droppedUnreferenced).toBe(0);
  });

  it("一行里既有合法又有编造的 ⇒ 整行丢（不允许「半真」）", () => {
    const r = filterClaims("- 结论 [[甲]] 与 att://y", allowed);
    expect(r.kept).toEqual([]);
    expect(r.droppedInventedRefs).toBe(1);
  });
});

describe("分批（不静默截断）", () => {
  const src = (ref: string, chars: number): SummarySource => ({ ref, kind: "page", text: "x".repeat(chars) });

  it("每个来源恰好进一批；每批不超预算（除单条超预算那种）", () => {
    const batches = planBatches([src("[[a]]", 30), src("[[b]]", 30), src("[[c]]", 30)], 80);
    expect(batches.flatMap((b) => b.refs).sort()).toEqual(["[[a]]", "[[b]]", "[[c]]"]);
    expect(batches.every((b) => b.chars <= 80 || b.oversize)).toBe(true);
  });

  it("★ 单条超预算 ⇒ 单独成批并标 oversize（**不切它**）", () => {
    const batches = planBatches([src("[[big]]", 500), src("[[small]]", 5)], 100);
    const big = batches.find((b) => b.refs.includes("[[big]]"))!;
    expect(big.oversize).toBe(true);
    expect(big.refs).toEqual(["[[big]]"]);
    expect(big.chars).toBeGreaterThan(100); // 原样送出，没有截断
    expect(big.text).toContain("x".repeat(500));
  });

  it("空文本的来源不进批（它没有可总结的东西）", () => {
    const batches = planBatches([{ ref: "[[空]]", kind: "page", text: "  " }, src("[[有]]", 5)], 100);
    expect(batches.flatMap((b) => b.refs)).toEqual(["[[有]]"]);
  });
});

describe("map-reduce 端到端（夹具驱动）", () => {
  for (const s of fx.scenarios) {
    it(`${s.id}`, async () => {
      const { fn, calls } = scripted(s.scripted);
      const seen: number[] = [];
      const out = await mapReduceSummarize({
        sources: s.sources,
        summarize: fn,
        budgetChars: 4000,
        onProgress: (done) => seen.push(done),
      });

      for (const frag of s.expect.markdownContains ?? []) expect(out.markdown).toContain(frag);
      for (const frag of s.expect.markdownNotContains ?? []) expect(out.markdown).not.toContain(frag);
      if (s.expect.refs) expect(out.refs).toEqual(s.expect.refs);
      if (s.expect.droppedUnreferenced !== undefined) expect(out.droppedUnreferenced).toBe(s.expect.droppedUnreferenced);
      if (s.expect.droppedInventedRefs !== undefined) expect(out.droppedInventedRefs).toBe(s.expect.droppedInventedRefs);
      if (s.expect.notFound !== undefined) expect(out.notFound).toBe(s.expect.notFound);
      if (s.expect.calls !== undefined) expect(calls.length).toBe(s.expect.calls);

      // ★ 全场景不变的硬性质：**输出里的每个回链都来自输入**（不许编造）
      const inputRefs = new Set(s.sources.map((x) => x.ref));
      for (const r of extractRefs(out.markdown)) {
        expect(inputRefs.has(r), `输出里出现了输入没有的回链：${r}`).toBe(true);
      }
      // 进度单调、终态 = 批数
      expect(seen).toEqual([...seen].sort((a, b) => a - b));
      if (out.batches.length > 0) expect(seen[seen.length - 1]).toBe(out.batches.length);
    });
  }

  it("★ 一条结论都没留下 ⇒ notFound，并在正文里说清为什么", async () => {
    const { fn } = scripted(["随便写点没有出处的话"]);
    const out = await mapReduceSummarize({
      sources: [{ ref: "[[甲]]", kind: "page", text: "有内容" }],
      summarize: fn,
    });
    expect(out.notFound).toBe(true);
    expect(out.markdown).toContain("查不到");
    expect(out.droppedUnreferenced).toBe(1);
  });

  it("问题会进抬头与提示词（便于人核对「它在总结什么」）", async () => {
    const { fn, calls } = scripted(["- 预算 8 万 att://a"]);
    const out = await mapReduceSummarize({
      sources: [{ ref: "att://a", kind: "attachment", text: "差旅预算 8 万" }],
      summarize: fn,
      question: "今年差旅花了多少？",
    });
    expect(out.markdown).toContain("今年差旅花了多少？");
    expect(calls[0]).toContain("今年差旅花了多少？");
    expect(calls[0]).toContain("att://a"); // 材料与它的回链一起送进去
  });
});

describe("transport 适配器", () => {
  it("把已配置的 transport 包成 SummarizeFn（并把 maxTokens 传下去）", async () => {
    const seen: { maxTokens?: number }[] = [];
    const fn = summarizerFromTransport(
      {
        complete: async (_m, o) => {
          seen.push(o ?? {});
          return { content: "- 结论 [[甲]]" };
        },
      },
      256,
    );
    expect(await fn("提示词")).toBe("- 结论 [[甲]]");
    expect(seen[0].maxTokens).toBe(256);
  });
});
