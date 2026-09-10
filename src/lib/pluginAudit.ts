import type { PluginAuditEntry } from "../types";

/**
 * 审计记录的**展示口径**（M11.13 阶段 4）。
 *
 * 审计环里现在有两类东西：
 *   · 能力调用（`pages.count` / `blocks.append` …）——插件碰了什么；
 *   · **运行记录**（`capability === "host.run"`）——这一次命令/事件跑完（或被杀）的结局，
 *     带峰值常驻内存。
 *
 * 抽成纯函数是为了可测：这里每一条判断都容易写错，而错了不会报错——只会让用户看到
 * "host.run" 这种内部名字，或者把"被杀"显示成"ok"。
 */
export const RUN_RECORD_CAPABILITY = "host.run";

export function isRunRecord(entry: Pick<PluginAuditEntry, "capability">): boolean {
  return entry.capability === RUN_RECORD_CAPABILITY;
}

/** 把字节数说成人话（审计里只用来展示，精度不重要，别显示 268435456 这种数）。 */
export function formatBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== "number" || bytes <= 0) return "";
  const mib = bytes / (1024 * 1024);
  if (mib >= 1) return `${mib.toFixed(1)} MiB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KiB`;
}

/** 一条审计记录的主文案。 */
export function auditTitle(entry: Pick<PluginAuditEntry, "capability" | "scope">): string {
  if (isRunRecord(entry)) {
    return entry.scope === "event" ? "事件运行" : "命令运行";
  }
  return entry.capability;
}

/** 一条审计记录的次要说明（作用域 / 峰值内存）。 */
export function auditDetail(
  entry: Pick<PluginAuditEntry, "capability" | "scope" | "peak_rss_bytes">,
): string {
  if (!isRunRecord(entry)) return entry.scope;
  const peak = formatBytes(entry.peak_rss_bytes);
  return peak ? `峰值内存 ${peak}` : "";
}

/** 状态标签：成功 / 错误码（运行记录成功时也说"完成"，免得和"能力调用成功"混）。 */
export function auditStatus(
  entry: Pick<PluginAuditEntry, "ok" | "error_code" | "capability">,
): string {
  if (entry.ok) return isRunRecord(entry) ? "完成" : "ok";
  return entry.error_code || "err";
}
