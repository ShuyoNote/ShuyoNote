import type { PluginMeta } from "../types";

/**
 * 「需要重新确认」这件事的用户可见文案（唯一一处）。
 *
 * 为什么单独抽出来：同一件事要在两个地方说（插件管理的提示条、命令面板里那条入口），
 * 而它们必须说成同一句话——一处说"插件更新了"、另一处说"权限变了"，用户会以为是两回事。
 *
 * 原则：**说清具体新增了什么**，而不是"插件发生了变化"这种让人无法判断的话。
 * 用户要做的是"看了新增项再决定"，所以新增项本身就是这句话的主语。
 */

/** 一句话说明为什么被暂停（短，用于入口后缀/标题）。 */
export function approvalLabel(): string {
  return "需重新确认";
}

/** 详细说明：为什么停、新增了什么、他该做什么。 */
export function approvalDetail(plugin: Pick<PluginMeta, "name" | "approval">): string {
  const added: string[] = [];
  if (plugin.approval.added_permissions.length > 0) {
    added.push(`权限 ${plugin.approval.added_permissions.join("、")}`);
  }
  if (plugin.approval.added_events.length > 0) {
    added.push(`事件 ${plugin.approval.added_events.join("、")}`);
  }
  const what = added.length > 0 ? added.join(" 与 ") : "声明内容";
  const from = plugin.approval.approved_version
    ? `你当初同意的是 v${plugin.approval.approved_version}`
    : "你当初同意的那份声明";
  return `「${plugin.name}」的文件被换成了新的版本，新增了 ${what}——在重新确认之前它不会运行（${from}）。`;
}

/** 这个插件是否处于「暂停等确认」状态。 */
export function needsApproval(plugin: Pick<PluginMeta, "approval">): boolean {
  return plugin.approval?.required === true;
}
