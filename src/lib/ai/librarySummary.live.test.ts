// P4 的**真跑**读数：跨库总结接**本机**模型（走仓里既有的 OpenAI 兼容 transport）。
//
// 为什么值得留着：判据用的是脚本化模型（确定性），而这一条回答的是另一个问题 ——
// **真模型会不会守"每条结论都要带出处"这条规矩**。它守不守不是我们能决定的，
// 所以我们**只断言可机检的那一条**：输出里出现的回链**必须来自输入**（不许编造）。
// （"它到底引了几条"只打印出来给人看 —— 真模型偶尔一条都不引，那是模型行为，不该让 CI 红。）
//
// 没有本机服务时**跳过**（与 `image.localVlm.test.ts` / `realSamples.test.ts` 同一条纪律）。

import { describe, expect, it } from "vitest";

import { createOpenAICompatTransport } from "./llm";
import { extractRefs, mapReduceSummarize, summarizerFromTransport, type SummarySource } from "./librarySummary";

const BASE = process.env.HERDSMAN_BASE ?? "http://127.0.0.1:8080/v1";
const MODEL = process.env.HERDSMAN_MODEL ?? "Qwen3.8-Flash-Next";

async function serviceUp(): Promise<boolean> {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 1500);
    const r = await fetch(`${BASE}/models`, { signal: ac.signal });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

const up = await serviceUp();
const skipReason = up ? "" : `本机模型服务不可达（${BASE}）—— 这是环境，不是回归`;

describe.skipIf(skipReason !== "")(`跨库总结·本机真跑（${skipReason || BASE}）`, () => {
  const SOURCES: SummarySource[] = [
    { ref: "[[季度总结]]", kind: "page", label: "季度总结", text: "本季度营收 1200 万，主要来自企业版。" },
    { ref: "pdf://att-pdf-1#2", kind: "pdf-page", label: "年报.pdf 第 3 页", text: "第 3 页：研发投入 300 万，占营收 25%。" },
    { ref: "att://att-9", kind: "attachment", label: "预算.xlsx", text: "差旅预算 8 万。" },
  ];

  it("★ 真模型总结：输出里的回链**全部来自输入**（不许编造），并打印原文给人看", async () => {
    const transport = createOpenAICompatTransport(BASE, MODEL);
    const out = await mapReduceSummarize({
      sources: SOURCES,
      summarize: summarizerFromTransport(transport, 1024),
      question: "本季度营收与研发投入分别是多少？",
    });

    console.log(`[live summary]\n${out.markdown}`);
    console.log(
      `[live summary] refs=${out.refs.length} batches=${out.batches.length} droppedUnreferenced=${out.droppedUnreferenced} droppedInventedRefs=${out.droppedInventedRefs}`,
    );

    // ★ 唯一的硬断言：**不许编造回链**（这条与模型发挥无关，是过滤器的职责）
    const inputRefs = new Set(SOURCES.map((s) => s.ref));
    for (const r of extractRefs(out.markdown)) {
      expect(inputRefs.has(r), `输出里出现了输入没有的回链：${r}`).toBe(true);
    }
    // 真跑至少要有产物（正文非空）
    expect(out.markdown.trim().length).toBeGreaterThan(0);
    expect(out.batches.length).toBeGreaterThan(0);
  }, 180_000);
});
