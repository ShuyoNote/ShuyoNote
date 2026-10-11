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

import { api } from "../api";
import { toast } from "../../store/toast";
import { importOfficeBytes } from "./importPipeline";
import { realOfficePathDeps, type OfficePathOutcome } from "./pathImport";

/**
 * ⭐ 2026-10-11（owner：「在 word 文档的右键菜单里面才有转成笔记」）：
 * ⭐ **把已经入库的 Word 附件**直接转成一页笔记 ✓ —— 界面上用户已经指着那个文件了 ✓，
 * ⚠️ 所以**不弹"选文件"框** ✗，⭐ 直接按它的内容指纹读字节 ✓（⭐ 内容寻址 ⇒ 不用管它落在哪个空间目录 ✓）。
 *
 * ⚠️ 与上面那条**共用** `importOfficeBytes` ＋ `realOfficePathDeps().importDeps` ✓ ——
 *    ⛔ 这里不碰解析 / 落库 ✓（⭐ 第二份真相源 ✓）。
 */
export async function importOfficeAttachmentAsPage(
  attachment: { hash: string; name: string },
  parentId: string | null,
): Promise<OfficePathOutcome> {
  const deps = realOfficePathDeps(parentId);
  const bytes = new Uint8Array(await api.readAttachmentBytes(attachment.hash));
  const result = await importOfficeBytes(bytes, attachment.name, parentId, deps.importDeps);
  const outcome: OfficePathOutcome = result.ok ? { ...result, attachmentName: attachment.name } : result;
  toast(outcome.ok ? "已转成笔记" : `没转成：${outcome.message}`, outcome.ok ? "success" : "error");
  return outcome;
}
