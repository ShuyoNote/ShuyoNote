// 第三块（按需单页）的判据：三条不变式在这层上的**成对断言** ＋ 一条静态断言（草稿不落库 ✓）。
// 口径来源：`docs/specs/2026-09-28-llm-wiki-spec.md` §1（三条 INV-WIKI-*）✓
//
// ⚠️ 回链格式**不是我发明的**：仓里已有四种唯一口径（`librarySummary.ts` 的 `REF_PATTERNS`）——
//    `[[页面标题]]` ／ `pdf://att-1#3` ／ `att://att-1` ／ `blk-<id>`。
//    第一版我按 `[p1]` 写，`extractRefs` 一个都认不出 ⇒ 所有行被当成"没回链"丢掉 ⇒ 判据当场红 ✓
//    （这正是"判据要在真值上验过再用"的又一例 ✓）

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  DRAFT_FOOTER,
  NO_MATERIAL_TEXT,
  allowedRefsOf,
  buildTopicPrompt,
  coverageNoteOf,
  generateTopicDraft,
  type TopicCoverage,
} from "./topicDraft";
import type { SummarySource } from "./librarySummary";
import type { MapSection } from "./libraryMap";

const HERE = dirname(fileURLToPath(import.meta.url));

const PAGE_REF = "[[同步总览]]";
const BLOCK_REF = "blk-a1b2c3";
const GHOST_REF = "blk-ghost999"; // 形状合法但**材料里没有** ⇒ 算"编造回链" ✓

const section: MapSection = {
  key: "themes",
  label: "专题",
  summary: "按主题聚出来的一页",
  items: [{ key: "t1", label: "同步架构", count: 3, tone: "ok", note: "材料齐", sources: [PAGE_REF, BLOCK_REF] }],
};

const sources: SummarySource[] = [
  { ref: PAGE_REF, kind: "page", label: "同步总览", text: "同步靠变更日志……" },
  { ref: BLOCK_REF, kind: "block", text: "冲突按时间戳定序……" },
];

const fixedNow = () => new Date("2026-09-29T02:00:00.000Z");

describe("generateTopicDraft —— 回链只来自输入（INV-WIKI-provenance）", () => {
  it("★ 模型编造的回链：那一行被丢掉，且 droppedInventedRefs 记 1（正文不出现它）", async () => {
    const summarize = async () => [`${PAGE_REF} 同步靠变更日志。`, `${GHOST_REF} 我编的结论。`, `${BLOCK_REF} 冲突按时间戳定序。`].join("\n");
    const d = await generateTopicDraft(section, sources, { summarize, model: "Qwen3:8B", now: fixedNow });

    expect(d.droppedInventedRefs).toBe(1);
    expect(d.body).toContain(PAGE_REF);
    expect(d.body).toContain(BLOCK_REF);
    expect(d.body).not.toContain("ghost999"); // 编造的回链**不许**出现在草稿里 ✓
  });

  it("refs 是输入的子集（不许拼、不许猜）", async () => {
    const summarize = async () => [`${PAGE_REF} 甲。`, `${BLOCK_REF} 乙。`, "att://att-999 库里没这条。"].join("\n");
    const d = await generateTopicDraft(section, sources, { summarize, model: "m", now: fixedNow });
    expect(new Set(d.refs)).toEqual(new Set([PAGE_REF, BLOCK_REF]));
    for (const r of d.refs) expect(allowedRefsOf(sources)).toContain(r);
  });

  it("没带任何回链的结论行也进不来（droppedUnreferenced 记数）", async () => {
    const summarize = async () => ["这是一句没有回链的结论。", `${PAGE_REF} 带回链的结论。`].join("\n");
    const d = await generateTopicDraft(section, sources, { summarize, model: "m", now: fixedNow });
    expect(d.droppedUnreferenced).toBeGreaterThan(0);
    expect(d.body).not.toContain("没有回链");
  });

  it("「查不到」那种**诚实声明**放行（不许惩罚诚实 ⇒ 逼它编一条假的）", async () => {
    const summarize = async () => ["查不到：本批材料里没有讨论过限流。", `${PAGE_REF} 甲。`].join("\n");
    const d = await generateTopicDraft(section, sources, { summarize, model: "m", now: fixedNow });
    expect(d.body).toContain("查不到");
    expect(d.droppedUnreferenced).toBe(0);
  });

  it("提示词里带上了被允许的回链清单（模型得先知道能引谁）", () => {
    const p = buildTopicPrompt(section, sources, allowedRefsOf(sources));
    expect(p).toContain(PAGE_REF);
    expect(p).toContain(BLOCK_REF);
    expect(p).toContain("未知"); // "材料不足就说未知"这条要求必须在提示词里 ✓
  });
});

describe("generateTopicDraft —— 覆盖度：没有读数就写「未知」（INV-WIKI-coverage-visible）", () => {
  it("★ 没有读数（null）⇒ 覆盖度写「未知」，且不出现 0/", async () => {
    const summarize = async () => `${PAGE_REF} 甲。`;
    const d = await generateTopicDraft(section, sources, { summarize, model: "m", coverage: null, now: fixedNow });
    expect(d.coverage).toContain("未知");
    expect(d.coverage).not.toContain("0/");
  });

  it("有读数 ⇒ 如实写 indexed/total，且不出现「未知」（成对断言）", async () => {
    const coverage: TopicCoverage = { indexed: 3, total: 9 };
    const summarize = async () => `${PAGE_REF} 甲。`;
    const d = await generateTopicDraft(section, sources, { summarize, model: "m", coverage, now: fixedNow });
    expect(d.coverage).toBe("覆盖度：3/9");
    expect(d.coverage).not.toContain("未知");
  });

  it("total 为 0 或坏读数 ⇒ 退回「未知」（不许写成 0/0 ✓）", () => {
    expect(coverageNoteOf({ indexed: 0, total: 0 })).toContain("未知");
    expect(coverageNoteOf(null)).toContain("未知");
  });
});

describe("generateTopicDraft —— 草稿不落库（INV-WIKI-readonly-default）", () => {
  it("★ 材料为空 ⇒ **不调模型**，正文写「材料不足：未知」，页脚照常有", async () => {
    let calls = 0;
    const summarize = async () => {
      calls++;
      return `${PAGE_REF} 不该被调用。`;
    };
    const d = await generateTopicDraft(section, [], { summarize, model: "m", now: fixedNow });
    expect(calls).toBe(0);
    expect(d.calledModel).toBe(false);
    expect(d.body).toBe(NO_MATERIAL_TEXT);
    expect(d.footer).toContain(DRAFT_FOOTER);
  });

  it("每页页脚都含「派生，非出处」＋ 模型名 ＋ 生成时间（可逐字比对）", async () => {
    const summarize = async () => `${PAGE_REF} 甲。`;
    const d = await generateTopicDraft(section, sources, { summarize, model: "Qwen3:8B", now: fixedNow });
    expect(d.footer).toBe("派生，非出处 ｜ 模型：Qwen3:8B ｜ 生成于：2026-09-29T02:00:00.000Z");
    expect(d.model).toBe("Qwen3:8B");
    expect(d.generatedAt).toBe("2026-09-29T02:00:00.000Z");
  });

  it("静态断言：这一层**不 import** 落库/平台/仓库（所以它出不了落库动作 ✓）", () => {
    const src = readFileSync(join(HERE, "topicDraft.ts"), "utf8");
    const imports = [...src.matchAll(/^import[^;]+from\s+"([^"]+)";/gm)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) {
      expect(spec).not.toMatch(/\bapply\b/);
      expect(spec).not.toMatch(/\bplatform\b/);
      expect(spec).not.toMatch(/\bstores?\b/);
      expect(spec).not.toMatch(/\bapi\b/);
    }
    // 也不许调用落库函数（即使有人以后 import 进来）
    expect(src).not.toMatch(/applySummary|createPage|pages\.create|create_page/);
  });
});
