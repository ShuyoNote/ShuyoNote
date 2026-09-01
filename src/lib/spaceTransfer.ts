import { api } from "./api";
import { platform } from "./platform";
import { toast } from "../store/toast";
import { confirmDialog } from "../store/confirm";
import { useSpaceStore } from "../store/space";
import { useNotes } from "../store/notes";
import { useSpaceTransfer } from "../store/spaceTransfer";

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

/** 导入空间包：始终**新建**一个空间，绝不覆盖现有空间。 */
export async function importSpacePackage(): Promise<void> {
  try {
    const path = await platform.dialog.open({
      title: "导入工作空间",
      filters: [{ name: "ZIP", extensions: ["zip"] }],
      multiple: false,
    });
    if (!path) return;
    const ok = await confirmDialog({
      title: "导入工作空间",
      message: "导入将新建一个工作空间（不会覆盖现有空间）。确定继续？",
    });
    if (!ok) return;
    const meta = await withProgress("准备导入…", "导入中…", () => api.importWorkspace(path as string));
    toast(`已导入工作空间「${meta.name}」`, "success");
    await useSpaceStore.getState().load();
  } catch (e) {
    toast(`空间导入失败：${e}`, "error");
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
