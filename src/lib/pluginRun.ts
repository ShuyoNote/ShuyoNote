import { $createParagraphNode, $createTextNode, $getRoot, $getSelection, $isRangeSelection } from "lexical";
import { useEditorStore } from "../store/editor";
import { usePlugins } from "../store/plugins";
import { toast } from "../store/toast";
import { api } from "./api";
import { platform } from "./platform";
import { confirmAndApplyDrafts } from "./pluginDrafts";
import { exportDialogOptions, exportOutcomeMessage, type ExportOutcome } from "./pluginExports";
import type { PluginExport } from "../types";

/**
 * 插件命令的**统一执行链路**（命令面板与编辑器 `/` 菜单共用）。
 *
 * 为什么必须只此一份：插件命令的副作用全部体现在返回值里——结果消息、`__toast` 提示、
 * 插入文本、**待确认的草稿**。任何一个入口自己实现一遍，都会出现"某个入口忘了处理草稿"
 * 的情况，而那就等于绕过写中介、直接改用户的笔记。触发方式（面板、`/`、右键）不该影响
 * 这条链路的行为。
 */

/** 把文本插入编辑器（光标处优先，否则追加到当前页末尾）。 */
export function insertTextIntoEditor(text: string) {
  const editor = useEditorStore.getState().editor;
  if (!editor) return;
  editor.update(() => {
    const para = $createParagraphNode();
    para.append($createTextNode(text));
    const sel = $getSelection();
    if ($isRangeSelection(sel)) sel.insertNodes([para]);
    else $getRoot().append(para);
  });
}

export interface PluginRunUiResult {
  /** 给用户看的一句话（已包含草稿确认的结果）。 */
  message: string;
  /** 用户取消了等待：结果被丢弃（无半途写入）。 */
  cancelled: boolean;
}

/**
 * 把 `api.files.export` 的产物写出去：**逐个**弹系统保存对话框。
 *
 * 为什么在这里（而不是每个入口各做一遍）：插件命令的副作用全部体现在返回值里，导出也是
 * 其中一种——命令面板、`/` 菜单、导入触发都走 `runPluginCommandWithUi`，所以"导出要不要
 * 问用户"这个问题只有一处答案。
 *
 * 三条规则：
 * - **用户点取消 = 没写任何东西**（如实回报，不混进"已完成"）；
 * - **写的是用户选定的那个路径**：插件只给了建议文件名，路径来自保存对话框；
 * - 写失败要说出来（文件名 + 原因），不能只报"导出完成"。
 */
export async function savePluginExports(exports: PluginExport[]): Promise<ExportOutcome> {
  const outcome: ExportOutcome = { written: 0, cancelled: 0, failed: [] };
  for (const item of exports) {
    let path: string | null = null;
    try {
      const chosen = await platform.dialog.save(exportDialogOptions(item));
      path = Array.isArray(chosen) ? chosen[0] : chosen;
    } catch (e) {
      outcome.failed.push({ fileName: item.file_name, error: String(e) });
      continue;
    }
    if (!path) {
      outcome.cancelled += 1;
      continue;
    }
    try {
      await api.writeTextFile(path, item.content);
      outcome.written += 1;
    } catch (e) {
      outcome.failed.push({ fileName: item.file_name, error: String(e) });
    }
  }
  return outcome;
}

/**
 * 执行一个插件命令并处理它的全部返回值。
 *
 * @param source 谁在跑（命令标题 / 插件名），用于草稿确认的提示文案
 */
export async function runPluginCommandWithUi(
  source: string,
  pluginId: string,
  commandId: string,
  currentPageId?: string | null,
  argsJson?: string,
): Promise<PluginRunUiResult> {
  const res = await usePlugins.getState().runCommand(pluginId, commandId, currentPageId, argsJson);
  if (res.cancelled) {
    // M11.13 起"取消"是真的终止那次运行的宿主子进程（见 store/plugins 的 cancelRun），
    // 所以文案如实说"已终止"，而不是从前那句"已取消等待"。
    return { message: "已终止插件（结果已丢弃）", cancelled: true };
  }
  for (const t of res.toasts ?? []) toast(t, "info");
  if (res.insert) insertTextIntoEditor(res.insert);

  const drafts = res.drafts ?? [];
  if (drafts.length > 0) {
    // 写能力不直接落库：草稿确认的规则只此一份（见 lib/pluginDrafts）。
    return { message: await confirmAndApplyDrafts(source, drafts), cancelled: false };
  }

  const exports = res.exports ?? [];
  if (exports.length > 0) {
    // 导出同样是"插件申请、用户决定"：这里弹的是系统保存对话框，点了取消就什么都没写。
    const outcome = await savePluginExports(exports);
    const head = res.message ? `${res.message}；` : "";
    return { message: head + exportOutcomeMessage(outcome), cancelled: false };
  }
  return { message: res.message, cancelled: false };
}
