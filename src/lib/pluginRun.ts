import { $createParagraphNode, $createTextNode, $getRoot, $getSelection, $isRangeSelection } from "lexical";
import { useEditorStore } from "../store/editor";
import { usePlugins } from "../store/plugins";
import { toast } from "../store/toast";
import { confirmAndApplyDrafts } from "./pluginDrafts";

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
    return { message: "已取消执行（结果已丢弃）", cancelled: true };
  }
  for (const t of res.toasts ?? []) toast(t, "info");
  if (res.insert) insertTextIntoEditor(res.insert);

  const drafts = res.drafts ?? [];
  if (drafts.length > 0) {
    // 写能力不直接落库：草稿确认的规则只此一份（见 lib/pluginDrafts）。
    return { message: await confirmAndApplyDrafts(source, drafts), cancelled: false };
  }
  return { message: res.message, cancelled: false };
}
