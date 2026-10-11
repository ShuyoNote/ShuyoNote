// ⭐ 2026-10-11（owner：「应用内右键导入笔记」）：⭐ 右键菜单那条用的「选文件 ⇒ 导入」入口 ✓。
//
// ⚠️ 与「从导入文件创建…」**共用同一条链**（`importOfficeFromPath` ＋ `realOfficePathDeps` ✓）——
//    ⛔ 这里**不碰解析/落库** ✓（⭐ 那就是第二份真相源 ✓，⭐ 本仓最忌这个 ✓）。
//
// ⚠️ 这一条**只认 .docx** ✗，理由是**上下文不同** ✓：
//    · 「从导入文件创建…」那条是**在某个页面里**点的 ⇒ ⭐ 它可以是"⭐ 把内容灌进当前页 ✗" ✓（⭐ 老行为 ✓）；
//    · 右键菜单那条是"⭐ 对某个页面 / 空目录 ✗"点的 ⇒ ⭐ 只有"⭐ 变成一页新笔记 ✗"这一种语义说得通 ✓。
//    ⇒ ⭐ 于是这里只放 Word ✓；⭐ Markdown 走那边 ✓（⭐ 两边都有活干，⛔ 不硬凑成一个 ✗）。
//
// ⚠️ 失败**不静默** ✓：⭐ 结果一律弹一句人话 ✓（⭐ 且把 `outcome` 交回调用方 ✓，⭐ 便于判据断言 ✓）。

import { platform } from "../platform";
import { toast } from "../../store/toast";
import { importOfficeFromPath, realOfficePathDeps, type OfficePathOutcome } from "./pathImport";

/** ⭐ 只认 Word（⭐ 第一期只有这条链 ✓）。 */
export const OFFICE_PICK_FILTERS = [{ name: "Word 文档", extensions: ["docx", "docm"] }];

/**
 * ⭐ 选一个 Word 文件 ⇒ 导入成一页新笔记 ✓。
 * `parentId` 给非空 ⇒ ⭐ 新页挂在它下面 ✓（⭐ 右键某个页面时就是这个语义 ✓）。
 * ⭐ 用户取消 ⇒ 返回 `null` ✓（⭐ 不弹任何东西 —— ⭐ 取消不是错误 ✓）。
 */
export async function pickAndImportOffice(parentId: string | null): Promise<OfficePathOutcome | null> {
  const selected = await platform.dialog.open({
    title: "选择 Word 文档（.docx）",
    filters: OFFICE_PICK_FILTERS,
    multiple: false,
  });
  if (!selected) return null;
  const path = Array.isArray(selected) ? selected[0] : selected;
  if (!path) return null;
  const outcome = await importOfficeFromPath(String(path), parentId, realOfficePathDeps(parentId));
  toast(outcome.ok ? "已导入为新笔记" : `没导入：${outcome.message}`, outcome.ok ? "success" : "error");
  return outcome;
}
