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
    for (const c of row.categories) {
      const retention = c.retention === null ? "  —  " : pct(c.retention);
      const flag = c.retention === null ? "·源里没有" : c.retention >= 1 ? "✓" : "⚠️ 有丢失";
      const truth = c.truth === undefined ? "" : `  （声明真值 ${c.truth}）`;
      lines.push(
        `   ${c.label.padEnd(4, "　")} ${String(c.source).padStart(4)} → ${String(c.converted).padStart(4)}   ${retention.padStart(7)}  ${flag}${truth}`,
      );
    }
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
