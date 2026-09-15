// P6.3 续（2026-09-15）：「字节不在本机时，从服务器按需取回来」的**唯一实现**。
//
// ## 为什么需要它
//
// 附件**行**是随 `changes` 同步到本机的，**字节不一定在**。这是**代码预期状态**，不是故障：
//   · P6.1 的「每空间开关」关掉之后，同步只走元数据、不传字节；
//   · C1 的预算刹车（磁盘余量 / 单文件阈值 / 本轮总量）也会把某些件挡在外面。
// 而在这些状态下点开一个文件，原来的行为是给一句"文件内容缺失（可能未同步到本机，或已被删除）"——
// **文案没错，但它是个死胡同**：字节完好地躺在服务器上，用户却只能自己想办法。
//
// P6.2/P6.3 在文件管理器里给了显式入口（「未下载」标记 + ☁ 按钮）。这里补的是
// **所有"应用内打开"路径**：不必让每个用户先回文件管理器找那个按钮。
//
// ## 为什么放在这一层，而不是每个调用点各写一遍
//
// 打开 PDF 有 **10 个调用点**（文件管理器 / 页面树 / 附件面板 / 内联附件引用 / PDF 引用 /
// 插件命令…），图片与 markdown 预览另有几处。把"先取字节再打开"写进每个调用点，
// 就等于把同一件事抄十遍——改一处忘一处是必然会发生的（这个仓里已经栽过几次）。
// 所以：**判据与取字节只有这一份**，由各处的"读取失败"分支调用。
import { api } from "./api";
import { toast } from "./../store/toast";
import { useSpaceStore } from "./../store/space";

/**
 * 确保这个 hash 的字节在本机可用。**已经在本机就直接返回 `true`，不发任何请求。**
 *
 * ⚠️ 判据用 `list_attachment_hashes`（走**附件目录**，不是数据库）——"数据库里有行"
 * 不代表"字节在盘上"，这正是本函数要修的那个区别。
 *
 * 返回 `false` 的三种情况都会给出可读的提示：没有活动空间 / 下载失败 / 服务端没有这份字节。
 */
export async function ensureAttachmentBytes(hash: string): Promise<boolean> {
  if (!hash) return false;
  const onDisk = await api.listAttachmentHashes().catch(() => [] as string[]);
  if (onDisk.includes(hash)) return true;

  const wsId = useSpaceStore.getState().activeId;
  if (!wsId) {
    toast("这个文件的字节不在本机，请先选择一个空间再下载", "error");
    return false;
  }
  try {
    await api.downloadAttachment(wsId, hash);
    toast("已从服务器取回文件", "success");
    return true;
  } catch (e) {
    toast(`取回文件失败：${e}`, "error");
    return false;
  }
}
