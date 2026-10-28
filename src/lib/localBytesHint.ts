/**
 * ⭐ **2026-10-28（owner：「在文件夹中打开失效了」）**：附件"本机有没有字节"这件事的**一处**处置。
 *
 * ## 为什么要有它
 * 附件是**按需取字节**的：数据库里有行（名字/大小/哈希），**盘上不一定有文件** ✓。
 * 三个「在文件夹中显示」入口原来都是 `if (!path) return;` —— **静默什么都不做** ⇒
 * 用户看到的就是"按钮失效了" ✗。
 *
 * ⇒ 现在：**先按需取回**（与页面里"打开"同一条通道 `download_attachment` ✓），取回来再显示；
 * 取不回（对面不在线 / 老版本）⇒ 如实说一句，并告诉下一步 ✓。
 * ⛔ 文案只此一处 ✗（三处各写一份迟早漂）。
 */
import { api } from "./api";
import { useSpaceStore } from "../store/space";

export const NOT_DOWNLOADED_HINT =
  "这一件在本机还没有字节（附件按需取回）⇒ 先在页面里打开它一次，取回来之后就能「在文件夹中显示」了";

/**
 * 取回这一件的字节，返回**本机路径**（失败抛人话原因）。
 *
 * ⚠️ `wsId` 用**当前活动空间**：附件按空间目录存（`attachments/<空间 id>/…`）✓；
 * 拿不到空间 id ⇒ 如实报"不知道取到哪个空间"（⛔ 不猜 ✗）。
 */
export async function fetchLocalAttachmentPath(hash: string): Promise<string> {
  const wsId = useSpaceStore.getState().activeId ?? "";
  if (!wsId) throw new Error("不知道取到哪个空间（当前没有活动空间）");
  if (!hash) throw new Error("这一件没有内容指纹（不知道要取哪一份）");
  await api.downloadAttachment(wsId, hash);
  return await api.attachmentPath(hash);
}

/**
 * ⭐ **2026-10-28（owner：「在侧边栏打开一个 html 文件失败」）**：**打开**（用系统默认应用）也要走同一条路。
 *
 * 症状：点「打开」⇒ toast「正在用系统默认应用打开…」⇒ 紧接「打开失败：Not allowed to open path」。
 * 真因：`path` 为空时**照样**调了 `open_path("")` —— 插件把空串当"不在允许范围" ⇒ 那句英文 ✗
 * （与「在文件夹中显示」同一族：**本机没字节**却被当成"路径非法"）。
 * ⇒ 先按需取回再打开；取不回就抛 `NOT_DOWNLOADED_HINT`（调用方 toast 它 ✓）。
 */
export async function ensureLocalAttachmentPath(path: string, hash?: string): Promise<string> {
  if (path) return path;
  if (!hash) throw new Error(NOT_DOWNLOADED_HINT);
  return await fetchLocalAttachmentPath(hash);
}
