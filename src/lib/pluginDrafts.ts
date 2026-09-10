import { confirmDialog } from "../store/confirm";
import type { PluginDraft } from "../types";
import { applyDraftAndRefresh } from "./applyDraftAndRefresh";

/**
 * 把插件产出的草稿摊给用户确认，确认后才落库。
 *
 * 为什么抽成共用函数：这条链路有**两个**入口——用户点插件命令（命令面板），
 * 以及事件钩子（例如「保存后自动打标签」，用户当时并没有在看确认框）。两处要是
 * 各写一遍，就迟早会出现"某一个入口忘了确认直接落库"，而那正是本插件体系最核心的
 * 承诺（插件永远不直接写你的笔记）。所以规则只此一份：
 *   - 先展示**具体要做什么**（summary 由后端生成，不是插件随便写的文案）；
 *   - 用户点了确定才走共用的 `applyDraftAndRefresh`（AI 与插件同一条落库链路）；
 *   - 拒绝就是**什么都不写**（而不是写一半）。
 *
 * @param source 谁提出的改动（命令标题 / 插件名 + 事件名），用于提示文案
 * @returns 给用户看的一句话结果
 */
export async function confirmAndApplyDrafts(source: string, drafts: PluginDraft[]): Promise<string> {
  if (drafts.length === 0) return "";
  const list = drafts.map((d, i) => `${i + 1}. ${d.summary}`).join("\n");
  const ok = await confirmDialog({
    title: "应用插件改动",
    message: `${source} 想对笔记做这些改动：\n\n${list}\n\n点「确定」才会真正写入。`,
  });
  if (!ok) return `已放弃 ${drafts.length} 项改动（未写入）`;

  const applied: string[] = [];
  for (const d of drafts) {
    try {
      const r = await applyDraftAndRefresh(d.payload);
      applied.push(r.ok ? `✓ ${d.summary}` : `✗ ${d.summary}：${r.message}`);
    } catch (e) {
      applied.push(`✗ ${d.summary}：${String(e)}`);
    }
  }
  return applied.join("；");
}
