import type { PluginExport } from "../types";

/**
 * 导出请求的**用户可见规则**（M11.9 收口）。
 *
 * 与 `pluginImports` 同样的理由抽成纯函数：这几条都容易写错，写错了不会报错——只会让
 * 用户看到一个莫名的保存对话框、或者以为"导出成功了"而其实一个文件都没写。
 *
 * 关键语义（与后端的中介一致）：**插件申请，用户决定**。
 * 插件给不出路径，只给一个建议文件名；存哪里、存不存由用户在系统保存对话框里定。
 * 用户点了取消 = **什么都没写**，这一点必须如实回报，不能算成功。
 */

/** 保存对话框的配置（标题 + 默认文件名 + 过滤器）。 */
export function exportDialogOptions(item: PluginExport): {
  title: string;
  defaultPath: string;
  filters: { name: string; extensions: string[] }[];
} {
  const ext = extensionOf(item.file_name);
  return {
    title: `保存「${item.file_name}」`,
    defaultPath: item.file_name,
    filters: ext ? [{ name: `${ext.toUpperCase()} 文件`, extensions: [ext] }] : [],
  };
}

/** 文件名的扩展名（不带点）；没有扩展名就返回空串。 */
export function extensionOf(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const i = base.lastIndexOf(".");
  if (i <= 0 || i === base.length - 1) return "";
  return base.slice(i + 1).toLowerCase();
}

/** 一次导出流程的结果（前端逐个保存对话框之后）。 */
export interface ExportOutcome {
  written: number;
  cancelled: number;
  /** 写失败的文件与原因（写出错也要说出来，不能只说"导出完成"）。 */
  failed: { fileName: string; error: string }[];
}

/**
 * 把导出结果拼成一句给用户的话。
 *
 * 四种情况都要说清，尤其是「取消」——把它混进"已完成"里等于骗用户：
 * - 全成功：已导出 N 个文件；
 * - 全取消：已取消导出（什么都没有写）；
 * - 部分取消：已导出 N 个；M 个已取消；
 * - 有失败：附上失败的文件名与原因（最多列两个，其余用"等"）。
 */
export function exportOutcomeMessage(outcome: ExportOutcome): string {
  const parts: string[] = [];
  if (outcome.written > 0) parts.push(`已导出 ${outcome.written} 个文件`);
  if (outcome.cancelled > 0) parts.push(`${outcome.cancelled} 个已取消（没有写任何东西）`);
  if (outcome.written === 0 && outcome.cancelled === 0 && outcome.failed.length === 0) {
    return "没有要导出的内容";
  }
  if (outcome.failed.length > 0) {
    const shown = outcome.failed.slice(0, 2).map((f) => `「${f.fileName}」失败：${f.error}`);
    const more = outcome.failed.length > 2 ? `，另有 ${outcome.failed.length - 2} 个失败` : "";
    parts.push(`${outcome.failed.length} 个导出失败（${shown.join("；")}${more}）`);
  }
  return parts.join("；");
}
