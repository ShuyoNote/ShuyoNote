// 「开始索引」的**运行模型**（纯逻辑，不含 DOM）—— 界面只负责把它接到按钮与进度条上。
//
// 为什么单独一层：
//   1. `indexLibrary()`（`indexPage.ts`）已经写好了编排与 `onProgress`，但**平台差异**与
//      "这个平台到底支不支持"必须在**一处**收口 —— 否则每个调用点都会各写一份，
//      而"界面承诺了做不到的事"正是这一族毛病的典型症状；
//   2. 这一层能被判据直接驱动（喂假的 `indexLibrary` 与假平台），不必装 DOM 测试环境
//      （仓库没有 testing-library）。
//
// 三步的关系：`platform.derivedStores?()`（装配）→ 本文件的 `runLibraryIndex`（运行 + 进度 + 摘要）
// → `AiSettingsForm`（按钮 + 进度条 + 报告）。

import type { ExtractDeps } from "./extract/types";
import type { Platform } from "./platform/types";
import { indexLibrary, type LibraryIndexReport } from "./indexPage";

/** 面向界面的进度（`ratio` 已算好，免得每个渲染点各算一次）。 */
export interface IndexProgress {
  done: number;
  total: number;
  label: string;
  /** `done / total`；`total` 为 0 时按 0 处理（不产生 NaN）。 */
  ratio: number;
}

export type IndexRunOutcome =
  | { ok: true; report: LibraryIndexReport; summary: string }
  | { ok: false; reason: string };

/** 平台是否具备索引能力。**不支持时给一句能直接显示的原因**（界面据此禁用按钮）。 */
export function indexAvailability(platform: Platform): { supported: true } | { supported: false; reason: string } {
  if (typeof platform?.derivedStores !== "function") {
    return {
      supported: false,
      reason: "本平台没有派生文本层的写入通道（桌面/Web 之外还没接），索引会写不进去，所以先不提供这个按钮。",
    };
  }
  return { supported: true };
}

/**
 * 跑一次全库索引。
 *
 * ⚠️ 平台不支持时**不抛**，返回 `{ ok: false, reason }`：调用方要把它当"一句可显示的话"，
 * 而不是一个异常（异常在 UI 里往往会变成一句没人看得懂的 `Error:`）。
 */
export async function runLibraryIndex(opts: {
  platform: Platform;
  /** 视觉模型（图片/扫描件/扫描页要用）。没给 ⇒ 需要它的抽取器走 `provider_error`（政策如此）。 */
  vision?: ExtractDeps["vision"];
  /** 语音转写（音视频要用）。没给 ⇒ `av.transcript@1` 走 `provider_error`（同一条政策）。 */
  transcribe?: ExtractDeps["transcribe"];
  onProgress?: (p: IndexProgress) => void;
}): Promise<IndexRunOutcome> {
  const avail = indexAvailability(opts.platform);
  if (!avail.supported) return { ok: false, reason: avail.reason };

  const stores = await opts.platform.derivedStores!();
  const report = await indexLibrary(stores, {
    ...(opts.vision ? { vision: opts.vision } : {}),
    ...(opts.transcribe ? { transcribe: opts.transcribe } : {}),
    onProgress: (done, total, label) =>
      opts.onProgress?.({
        done,
        total,
        label,
        ratio: total > 0 ? Math.min(1, Math.max(0, done / total)) : 0,
      }),
  });
  return { ok: true, report, summary: formatIndexSummary(report) };
}

/**
 * 把报告压成一句能显示的话：**底层摘要 + 失败明细（前 3 条）**。
 *
 * 为什么把失败单独提出来：`indexLibrary` 的不变量是"一页失败不停整个库"，
 * 所以"跑完了"和"全都成了"是两件事 —— 只显示"完成"会让用户以为没有坏页。
 */
export function formatIndexSummary(report: LibraryIndexReport): string {
  const base = report.summary;
  const fails = report.failures ?? [];
  if (fails.length === 0) return base;
  const head = fails
    .slice(0, 3)
    .map((f) => `${f.kind === "page" ? "页面" : "附件"} ${f.id}（${f.reason}）`)
    .join("、");
  const more = fails.length > 3 ? ` 等 ${fails.length} 条` : "";
  return `${base}；另有 ${fails.length} 条没成：${head}${more}`;
}
