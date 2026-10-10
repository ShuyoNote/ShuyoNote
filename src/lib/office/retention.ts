// **判据管道：保留率 ＋ 耗时**（Office 导入第一期 · 2026-10-09）。
//
// ## 为什么这个文件存在（评估文档 §3-⑤）
// 方案原文写的指标是"标题保留率 ≥98%、图片提取率 ≥95%、满意度 ≥4.5" ✗ —— **无样本、无命令**
// ⇒ 不可判，等于"文档说它对"✓。这里把它换成**机器可判**的三件事：
//   ① **样本**（`sampleDocx.ts` 现造真 docx，带声明真值 ✓）
//   ② **一条命令**（`npx vitest run src/lib/office/retention.test.ts` ⇒ 打印下表 ✓）
//   ③ **两个分母**：源 XML 数出来的（任何 docx 都能算 ✓）＋ 样本声明真值（只对合成样本，钉"数得对" ✓）
//
// ## 保留率的定义（写清楚，免得被读成别的东西）
//   保留率 = **转成块的数量 / 源里数到的数量**，五类各算一个 ✓。
//   ⚠️ 分母只数**有内容的**构造（空段落不算 —— 见 `ooxml.ts::docxToNoteBlocks` 里的注释 ✓）。
//   ⚠️ 失败样本**不给保留率**（打印 `—`）：⛔ 不把"没转成"写成 0%，也不写成 100% ✗
//      —— 那两种写法都会把"如实失败"伪装成一个数字 ✓。

import { docxToNoteBlocks, type NoteBlockCounts } from "../extract/ooxml";
import type { OfficeSample } from "./sampleDocx";

export type CategoryKey = keyof NoteBlockCounts;

export const CATEGORIES: readonly { key: CategoryKey; label: string }[] = [
  { key: "headings", label: "标题" },
  { key: "paragraphs", label: "段落" },
  { key: "listItems", label: "列表项" },
  { key: "images", label: "图片" },
  { key: "tables", label: "表格" },
];

export interface CategoryReading {
  key: CategoryKey;
  label: string;
  /** 源里数到的（分母）。 */
  source: number;
  /** 转成块的数量（分子）。 */
  converted: number;
  /** `converted / source`；源里没有这一类 ⇒ `null`（打印 `—` ✓）。 */
  retention: number | null;
  /** 样本声明的真值（只有合成样本有）。 */
  truth?: number;
}

export interface RetentionRow {
  name: string;
  note: string;
  bytes: number;
  ms: number;
  ok: boolean;
  code?: string;
  message?: string;
  categories: CategoryReading[];
  warnings: string[];
  /** 与声明真值逐类比对的结果（只有合成样本有；`null` ＝ 没真值可对 ✓）。 */
  truthMatches: boolean | null;
  truthDiff: string[];
}

function pct(x: number): string {
  return `${(Math.round(x * 1000) / 10).toFixed(1)}%`;
}

/**
 * 量一个样本（**同步**：转换本身是纯解析 ⇒ 不需要异步 ✓）。
 * `truth` 给了就同时比"转出来的"与"声明的"（抓"分母自己算错"那类错 ✓）。
 */
export function measureOne(
  name: string,
  note: string,
  bytes: Uint8Array,
  truth?: NoteBlockCounts,
): RetentionRow {
  const started = Date.now();
  const result = docxToNoteBlocks(bytes);
  const ms = Date.now() - started;

  if (!result.ok) {
    return {
      name,
      note,
      bytes: bytes.length,
      ms,
      ok: false,
      code: result.code,
      message: result.message,
      categories: [],
      warnings: [],
      truthMatches: null,
      truthDiff: [],
    };
  }

  const categories: CategoryReading[] = CATEGORIES.map(({ key, label }) => {
    const source = result.source[key];
    const converted = result.converted[key];
    return {
      key,
      label,
      source,
      converted,
      retention: source === 0 ? null : converted / source,
      truth: truth ? truth[key] : undefined,
    };
  });

  const truthDiff: string[] = [];
  if (truth) {
    for (const { key, label } of CATEGORIES) {
      if (truth[key] !== result.converted[key]) {
        truthDiff.push(`${label}：声明的真值 ${truth[key]} ≠ 转成块 ${result.converted[key]}`);
      }
    }
  }

  return {
    name,
    note,
    bytes: bytes.length,
    ms,
    ok: true,
    categories,
    warnings: result.warnings,
    truthMatches: truth ? truthDiff.length === 0 : null,
    truthDiff,
  };
}

export function measureSamples(samples: readonly OfficeSample[]): RetentionRow[] {
  return samples.map((s) => measureOne(s.name, s.note, s.bytes, s.truth));
}

/**
 * ⭐ **门槛**（评估 §3-⑤ 把它从"文档说它对"变成机器判 ✓）。
 *
 * 方案 §7.3 写的是「标题保留率 ≥98%、图片提取率 ≥95%」—— 那两个数**不是**我发明的：
 * 它们取自方案本身 ✓；其余三类（段落／列表项／表格）方案没给数，这里按**同一族的保守值**取
 * （段落 98% 与标题同级、列表项/表格 95% 与图片同级），⚠️ 并在报告里逐条打印门槛值，
 * 让"我们其实放宽了哪一类"一眼可见 ✓（⛔ 不藏 ✗）。
 *
 * ⚠️ 分母为 0 的类别（源里根本没有）**不参与门槛判定** —— 那不是"100% 达标"，是"没这一类" ✓
 *    （拿它当达标正是"指标不可判"的另一种形态 ✗）。
 */
export const RETENTION_THRESHOLDS: Record<CategoryKey, number> = {
  headings: 0.98,
  paragraphs: 0.98,
  listItems: 0.95,
  images: 0.95,
  tables: 0.95,
};

/**
 * ⭐ **上界**：保留率 **> 100%** 也算**不达标** ✓
 * —— "多了"和"少了"一样是症状：内容被**重复计数**或**归错类** ✗（Lead 2026-10-09 拍 ✓）。
 *
 * ⚠️ **只加在实测会超的三类上**，⛔ 不无脑套满五类 ✗（每一类的依据写在下面 ✓）：
 *  - `paragraphs`：列表项/标题被归错类时会**搬到段落** ⇒ 实测 6 → 12 ＝ **200%**
 *    （那是"列表支路被短路"那次真变异的读数 ✓ —— 同一份红同时产出 <95% 与 >100% ✓）
 *  - `listItems`：同一段若被两条 `numPr` 路径各收一次 ⇒ 会 >100%（分母是"有内容的列表段" ✓）
 *  - `tables`：同一张表被 `body` 与 `sdt` 各扫一次（内容控件/嵌套）⇒ 会 >100%
 *  ⛔ `headings`／`images` **不加**：一个 `w:p` 只可能判出一个标题层级 ✓；图片的分子分母**在同一个循环里**
 *    按"引用数"数（`source.images` 与 `converted.images` 同源 ✓）⇒ 结构上超不过 ✓。
 *  ⚠️ 将来若某一类**天然**可能 >100%（例如解析器有意补全/拆分）⇒ **把依据写在这里** ✓，⛔ 别硬套 ✗。
 */
export const RETENTION_MAX: Partial<Record<CategoryKey, number>> = {
  paragraphs: 1,
  listItems: 1,
  tables: 1,
};

export interface ThresholdVerdict {
  /** 所有"源里有"的类别都达到门槛 ⇒ true。 */
  ok: boolean;
  /** 逐条不达标的说明（命令式的读数，不是形容词 ✓）。 */
  failures: string[];
  /** 参与判定的类别数（源里没有的那几类不算 ✓）。 */
  judged: number;
}

/** 门槛判定（纯函数 ⇒ 判据与报告**共用同一份**，⛔ 不写第二份口径 ✗）。 */
export function thresholdVerdict(row: RetentionRow): ThresholdVerdict {
  const failures: string[] = [];
  let judged = 0;
  if (!row.ok) {
    // 如实失败 ⇒ 不是"达标"，也不是"0%"：单独一句话说清楚 ✓
    return { ok: false, failures: [`${row.name}：转换失败（[${row.code}] ${row.message}）⇒ 无保留率可言`], judged: 0 };
  }
  for (const c of row.categories) {
    if (c.retention === null) continue;
    judged += 1;
    const threshold = RETENTION_THRESHOLDS[c.key];
    const ceiling = RETENTION_MAX[c.key];
    if (ceiling !== undefined && c.retention > ceiling) {
      // ⭐ 双向门槛的上界那一侧：多了 ≠ 好事 ✓
      failures.push(
        `${row.name} · ${c.label}：保留率 ${pct(c.retention)} 超过上界 ${pct(ceiling)} ⇒ 内容被重复计数或归错类（${c.converted}/${c.source}）`,
      );
    } else if (c.retention < threshold) {
      failures.push(
        `${row.name} · ${c.label}：保留率 ${pct(c.retention)} 低于门槛 ${pct(threshold)}（${c.converted}/${c.source}）`,
      );
    }
  }
  return { ok: failures.length === 0, failures, judged };
}

/**
 * 人看的那张表（判据管道打印它）✓。
 * ⚠️ 失败样本**逐条打印失败原因**，并明写"未生成空笔记" —— 这正是"看过它红"要的证据 ✓。
 */
export function renderRetentionReport(rows: readonly RetentionRow[]): string {
  const lines: string[] = [];
  const total = rows.length;
  const okCount = rows.filter((r) => r.ok).length;
  lines.push(`Office 导入 · 保留率与耗时（样本 ${total}：成功 ${okCount} / 如实失败 ${total - okCount}）`);
  lines.push("");

  for (const row of rows) {
    const kb = (row.bytes / 1024).toFixed(1);
    if (!row.ok) {
      lines.push(`── ${row.name} ── ${kb} KB · 转换 ${row.ms} ms`);
      lines.push(`   ✗ 如实失败 [${row.code}] ${row.message}`);
      lines.push(`   ⇒ **没有生成笔记**（判据要求"可读失败"，⛔ 不许静默出空笔记）`);
      lines.push("");
      continue;
    }
    lines.push(`── ${row.name} ── ${kb} KB · 转换 ${row.ms} ms`);
    const verdict = thresholdVerdict(row);
    for (const c of row.categories) {
      const retention = c.retention === null ? "  —  " : pct(c.retention);
      const threshold = RETENTION_THRESHOLDS[c.key];
      const ceiling = RETENTION_MAX[c.key];
      const flag =
        c.retention === null
          ? "·源里没有"
          : ceiling !== undefined && c.retention > ceiling
            ? `✗ **超过上界 ${pct(ceiling)}**（重复计数／归错类）`
            : c.retention >= 1
              ? "✓"
              : c.retention >= threshold
                ? `⚠️ 有丢失（仍在门槛 ${pct(threshold)} 之上）`
                : `✗ **低于门槛 ${pct(threshold)}**`;
      const truth = c.truth === undefined ? "" : `  （声明真值 ${c.truth}）`;
      lines.push(
        `   ${c.label.padEnd(4, "　")} ${String(c.source).padStart(4)} → ${String(c.converted).padStart(4)}   ${retention.padStart(7)}  ${flag}${truth}`,
      );
    }
    lines.push(
      verdict.ok
        ? `   门槛判定 ✓ ${verdict.judged} 类（源里有内容的那些）全部达标`
        : `   门槛判定 ✗ ${verdict.failures.length} 条不达标：${verdict.failures.join("；")}`,
    );
    if (row.truthMatches === false) {
      lines.push(`   ✗ 与声明真值不一致：${row.truthDiff.join("；")}`);
    } else if (row.truthMatches === true) {
      lines.push(`   真值比对 ✓ 五类与样本声明一致`);
    }
    for (const w of row.warnings) lines.push(`   ⚠️ ${w}`);
    lines.push("");
  }

  const failed = rows.filter((r) => !r.ok);
  if (failed.length > 0) {
    lines.push(`如实失败 ${failed.length} 个（⛔ 这些**不算通过**、也不算"转换率"的分母）：`);
    for (const f of failed) lines.push(`   · ${f.name} [${f.code}] ${f.message}`);
  }
  return lines.join("\n");
}
