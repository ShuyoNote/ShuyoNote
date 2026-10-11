// **保留率门槛判据**（评估 §3-⑤）—— 把「标题保留率 ≥98%／图片提取率 ≥95%」从
// **"文档说它对"** ✗ 变成**机器判** ✓。
//
// ## 一条命令
//   npx vitest run src/lib/office/retentionThresholds.test.ts --reporter=verbose
//
// ## 门槛从哪来（⛔ 不是我发明的数）
// 方案 §7.3 自己写的两个数：标题 ≥98%、图片 ≥95% ⇒ 见 `retention.ts::RETENTION_THRESHOLDS` ✓
// （其余三类的取值理由写在那里，并在报告里逐条打印 ⇒ "我们放宽了哪一类"一眼可见 ✓）。
//
// ## ⭐ 这条判据为什么不是空转（两个"会红"的真输入/真变异）
//   ① **真输入**：`imageWithoutBytesSample()` —— 2 处图片引用、只有 1 张的字节在 ⇒
//      图片保留率 50% < 95% ⇒ `thresholdVerdict()` 判红 ✓（本文件第二条用例）
//   ② **真变异**：把解析层"列表"那条支路短路 ⇒ 列表项保留率 0% ⇒ 门槛判红（读数见提交信息/报告）✓
//
// ⚠️ 分母为 0 的类别**不参与**判定（源里没有 ⇒ 不是"100% 达标"）—— 那是"指标不可判"的另一种形态 ✗。

import { describe, expect, it } from "vitest";

import {
  measureOne,
  measureSamples,
  renderRetentionReport,
  RETENTION_MAX,
  RETENTION_THRESHOLDS,
  thresholdVerdict,
  type RetentionRow,
} from "./retention";
import { imageWithoutBytesSample, officeSamples } from "./sampleDocx";

describe("保留率门槛（§3-⑤：标题 ≥98% / 图片 ≥95%，机器判）", () => {
  it("三个已知样本 ⇒ 逐条达标（并打印实测值 ＋ 门槛）", () => {
    const rows = measureSamples(officeSamples());
    // eslint-disable-next-line no-console
    console.log(`\n${renderRetentionReport(rows)}\n`);
    for (const row of rows) {
      const verdict = thresholdVerdict(row);
      expect(verdict.failures, `${row.name} 不达标：${verdict.failures.join("；")}`).toEqual([]);
      expect(verdict.ok, `${row.name} 门槛判定应当达标`).toBe(true);
      expect(verdict.judged, `${row.name} 至少要有一类参与判定`).toBeGreaterThan(0);
    }
  });

  it("⭐ 真输入对照：图片字节缺失 ⇒ 图片保留率 50% < 95% ⇒ **这条门槛会红**（证明它不空转）", () => {
    const sample = imageWithoutBytesSample();
    const row = measureOne(sample.name, sample.note, sample.bytes, sample.truth);
    // 文档本身能转（文字照出）—— 它**不是**坏样本
    expect(row.ok, row.ok ? "" : `竟然整份失败：${row.code} ${row.message}`).toBe(true);
    if (!row.ok) return;

    const images = row.categories.find((c) => c.key === "images");
    expect(images, "五类里应当有图片这一类").toBeTruthy();
    expect(images!.source, "分母：2 处引用（关系都在）").toBe(2);
    expect(images!.converted, "分子：只有 1 张有字节").toBe(1);
    expect(images!.retention!).toBeLessThan(RETENTION_THRESHOLDS.images); // 0.5 < 0.95 ✓

    const verdict = thresholdVerdict(row);
    expect(verdict.ok, "门槛**必须**判红 —— 判绿就说明这条判据是空转的").toBe(false);
    expect(verdict.failures.join("；")).toContain("图片");
    expect(verdict.failures.join("；")).toContain("门槛");

    // 报告里必须**看得见**这条红（⛔ 不许只在测试里红、人看不到 ✗）
    const report = renderRetentionReport([row]);
    expect(report).toContain("低于门槛");
    expect(report).toContain("门槛判定 ✗");
    // 而且**不许静默**：解析层自己那条 warning 要在
    expect(row.warnings.join("；")).toContain("取不到字节");
  });

  it("门槛值就是方案给的那两个数（谁要放宽，⛔ 必须显式改这里 ＋ 说明）", () => {
    expect(RETENTION_THRESHOLDS.headings, "方案 §7.3 的标题保留率").toBe(0.98);
    expect(RETENTION_THRESHOLDS.images, "方案 §7.3 的图片提取率").toBe(0.95);
  });

  it("⭐ 门槛是**双向**的：保留率 > 100% 也算不达标（重复计数／归错类，不是好事）", () => {
    // ⭐ 这一条的形状来自**真变异读数**：把解析层「列表」支路短路 ⇒ 列表项被当成段落 ⇒
    //    段落 6 → 12 ＝ **200%**、列表项 6 → 0 ＝ 0%（同一份红同时产出两侧 ✓）。
    const inflated: RetentionRow = {
      name: "重复计数对照",
      note: "段落被算了两遍（真变异的形状）",
      bytes: 0,
      ms: 0,
      ok: true,
      categories: [
        { key: "paragraphs", label: "段落", source: 6, converted: 12, retention: 2 },
        { key: "listItems", label: "列表项", source: 6, converted: 0, retention: 0 },
      ],
      warnings: [],
      truthMatches: null,
      truthDiff: [],
    };
    const verdict = thresholdVerdict(inflated);
    expect(verdict.ok, ">100% 必须判红 —— 否则'多了'就没人管了").toBe(false);
    expect(verdict.failures.length, "两侧各一条：超过上界 与 低于门槛").toBe(2);
    expect(verdict.failures.join("；")).toContain("超过上界");
    expect(verdict.failures.join("；")).toContain("重复计数");
    expect(verdict.failures.join("；")).toContain("低于门槛");

    const report = renderRetentionReport([inflated]);
    expect(report).toContain("超过上界");
    expect(report).toContain("门槛判定 ✗");

    // ⛔ 上界**只加在实测会超的三类**上（headings / images 结构上超不过 ⇒ 不套）
    expect(RETENTION_MAX.paragraphs).toBe(1);
    expect(RETENTION_MAX.listItems).toBe(1);
    expect(RETENTION_MAX.tables).toBe(1);
    expect(RETENTION_MAX.headings, "标题只会少不会多 ⇒ 不判上界").toBeUndefined();
    expect(RETENTION_MAX.images, "图片分子分母同源（引用数）⇒ 不判上界").toBeUndefined();
  });

  it("分母为 0 的类别不参与判定（源里没有 ⇒ 不是'达标'）", () => {
    const row = measureOne("小样本.docx", "1 标题 ＋ 1 段落", officeSamples()[0].bytes);
    expect(row.ok).toBe(true);
    if (!row.ok) return;
    const verdict = thresholdVerdict(row);
    // 这个样本里有标题＋段落 ⇒ 只判这两类；图片/列表/表格是"源里没有"，不进 judged
    expect(verdict.judged).toBe(2);
    expect(verdict.ok).toBe(true);
  });
});
