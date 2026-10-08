import { api } from "./api";
import { contentJsonToYDoc } from "./crdt/yDocBridge";

/**
 * ⭐ **R155**：把一页的 **CRDT 状态按它的新正文重新播种** ✓ —— 外部写（MCP／插件）落库之后必须做这一步 ✗。
 *
 * ## 现场（owner 2026-10-08，读数 ✓）
 *
 * 外部写落库后：正文 **77 字、含那段文字** ✓，而该页 `page_crdt` 那 **440 字节**状态里**搜不到那段文字** ✗
 * （逐字 `状态里含探针文字 = False` ✓）⇒ **应用重启**时按状态重建/合并 ⇒ **旧内容赢** ✗
 * （`changes` 里记成一次普通 upsert，发生在**启动后约 12 秒** ✓）⇒ 已复现**三次** ✓。
 * ⇒ ⇒ 免确认档的写入**不能算落定** ✗ —— 重启一次可能就没了 ✓（R150 那个 3 秒窗口盖不住它 ✗）。
 *
 * ## 口径（owner 2026-10-08 拍 **选项 a** ✓，见台账 R155）
 *
 * **重新播种**（最小、可逆 ✓）：把新正文编成一份状态并落盘 ⇒ 状态与正文一致 ✓。
 * ⛔ **代价**：这一页**原有的 CRDT 血统丢了** ✗（跨机合并对"外部整篇替换过"的页不再有共同祖先 ✓）。
 *   ⇒ 这是**有意的取舍** ✓：外部写的语义本来就是"整篇替换" ✓，把它对齐到 CRDT 上也应当如此 ✓。
 *   （另两个选项 (b) 并进去 ／ (c) 清空状态 见台账 ✓，都留档 ✓。）
 *
 * ## 为什么失败不算落库失败 ✗
 *
 * 播种是**补状态** ✓，正文已经落了 ✓ ⇒ 它失败不该把"写成功了"变成"写失败" ✗；
 * 但**必须留痕** ✓（R150 那套回执日志 ✓），否则又是一条"看着成功、状态里没有"的静默路径 ✗。
 */
export async function reseedCrdtStateFromContent(pageId: string, docJson: string): Promise<void> {
  const { update } = contentJsonToYDoc(String(docJson ?? ""));
  await api.savePageState(pageId, update);
}
