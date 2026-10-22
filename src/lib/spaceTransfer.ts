import { api } from "./api";
import { platform } from "./platform";
import { toast } from "../store/toast";
import { confirmDialog } from "../store/confirm";
import { useSpaceStore } from "../store/space";
import { useNotes } from "../store/notes";
import { useSpaceTransfer } from "../store/spaceTransfer";
import type { WorkspaceMeta } from "../types";

// 单空间迁移（导出 / 导入空间包）。
//
// 从 PageTree 抽出来，是因为入口已从侧栏弹层移到设置中心「空间」页，而进度要
// 在**任何面板关闭后仍可见**——所以进度写进 `useSpaceTransfer`，由 App 级
// overlay 渲染；这里只负责流程与错误处理。
//
// 桌面与 Web 共用：`workspace-progress` 事件在桌面由 Rust 发出，Web 侧
// 由 driver 用 CustomEvent 派发，同一个监听器两端都work。

function safeName(name: string): string {
  return (name || "space")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, "-")
    .trim()
    .slice(0, 40);
}

async function withProgress<T>(initial: string, fallback: string, run: () => Promise<T>): Promise<T> {
  const setProgress = useSpaceTransfer.getState().setProgress;
  setProgress({ done: 0, total: 1, message: initial });
  const unlisten = await platform.event.listen<{ done: number; total: number; message: string }>(
    "workspace-progress",
    (e) => {
      const p = e.payload;
      if (p && typeof p.done === "number") {
        setProgress({ done: p.done, total: p.total || 1, message: p.message || fallback });
      }
    },
  );
  try {
    return await run();
  } finally {
    setProgress(null);
    unlisten();
  }
}

/** 导出**当前**空间为 zip 包（含该空间引用到的附件子集）。 */
export async function exportCurrentSpace(currentName: string): Promise<void> {
  try {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const path = await platform.dialog.save({
      title: "导出当前工作空间",
      defaultPath: `space-${safeName(currentName)}-${stamp}.zip`,
      filters: [{ name: "ZIP", extensions: ["zip"] }],
    });
    if (!path) return;
    const result = await withProgress("准备导出…", "导出中…", () => api.exportWorkspace(path));
    toast(
      `空间导出完成：大小 ${(result.size / 1024).toFixed(1)} KB${result.attachments ? ` · 附件 ${result.attachments} 个` : ""}`,
      "success",
    );
  } catch (e) {
    toast(`空间导出失败：${e}`, "error");
  }
}

/**
 * 导入空间包：始终**新建**一个空间，绝不覆盖现有空间。
 *
 * ⭐ 2026-10-22：**返回新空间的元信息**（`null` ＝ 用户取消 / 失败）。
 * 为什么改返回值：移动端**没有空间切换器** ⇒ 只"导入成功"用户也看不到东西
 * （没有切换入口 ＝ 死路，与"浮＋建空页落只读屏"同族）⇒ 调用方必须拿到 `id`
 * 才能立刻 `switchTo` 过去。桌面那边忽略返回值即可（行为一字不变）。
 */
export async function importSpacePackage(): Promise<WorkspaceMeta | null> {
  try {
    const path = await platform.dialog.open({
      title: "导入工作空间",
      filters: [{ name: "ZIP", extensions: ["zip"] }],
      multiple: false,
    });
    if (!path) return null;
    const ok = await confirmDialog({
      title: "导入工作空间",
      message: "导入将新建一个工作空间（不会覆盖现有空间）。确定继续？",
    });
    if (!ok) return null;
    const meta = await withProgress("准备导入…", "导入中…", () => api.importWorkspace(path as string));
    toast(`已导入工作空间「${meta.name}」`, "success");
    await useSpaceStore.getState().load();
    return meta;
  } catch (e) {
    toast(`空间导入失败：${e}`, "error");
    return null;
  }
}

/** 删除（软删）一个空间；调用方负责二次确认。返回是否成功。 */
export async function removeSpace(id: string): Promise<boolean> {
  const name = useSpaceStore.getState().spaces.find((s) => s.id === id)?.name ?? "该工作空间";
  const ok = await useSpaceStore.getState().remove(id);
  if (ok) {
    await useNotes.getState().loadPages();
    toast(`已删除工作空间「${name}」`, "success");
  }
  return ok;
}
