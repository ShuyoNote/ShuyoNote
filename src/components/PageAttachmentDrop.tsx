// 外部文件拖拽：正文区 = 挂附件 + 插入正文卡片；附件区 = 只挂附件（owner 2026-11-09 选 A+）。
//
// 关键约束：**桌面壳的 HTML5 拖拽被 `dragDropEnabled` 抑制** ⇒ 桌面只能靠 Tauri 的
// `webview.onDragDropEvent`（over/leave/drop + 物理像素坐标），再用 `elementFromPoint`
// 找出鼠标下是「正文区」还是「附件区」。Web 平台没有本地文件路径 ⇒ 明确提示走附件按钮
// （⛔ 不假装支持：拖进来的 `File` 没有路径，`import_attachment_files` 拿不到）。
import { useEffect, useState } from "react";
import { $getRoot } from "lexical";
import { platform } from "../lib/platform";
import { api } from "../lib/api";
import { toast } from "../store/toast";
import { useAttachmentsStore } from "../store/attachments";
import { useEditorStore } from "../store/editor";
import { $createAttachmentRefNode } from "../editor/nodes/AttachmentRefNode";
import { dropHintText, resolveDropZone, toCssPoint, type PageDropZone } from "../lib/pageAttachmentDrop";

/** 桌面壳是否可用（Web 平台没有本地路径 ⇒ 拖拽不可用，但仍给出可理解的提示）。 */
function hasTauriShell(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** 导入 +（可选）插入正文；返回是否成功（失败已经 toast 过，调用方不再重复报）。 */
export async function importDroppedAttachments(
  pageId: string,
  paths: string[],
  zone: PageDropZone,
): Promise<boolean> {
  if (paths.length === 0) return false;
  try {
    const metas = await api.importAttachmentFiles(pageId, paths);
    useAttachmentsStore.getState().bump();
    if (metas.length === 0) {
      toast("没有可添加的附件", "info");
      return true;
    }
    if (zone === "editor") {
      const editor = useEditorStore.getState().editor;
      if (editor) {
        editor.update(() => {
          const root = $getRoot();
          for (const m of metas) {
            root.append($createAttachmentRefNode(m.id, m.name, m.size, m.mime, m.hash, m.path));
          }
        });
      }
    }
    toast(
      zone === "editor" ? `已添加 ${metas.length} 个附件并插入正文` : `已添加 ${metas.length} 个附件`,
      "success",
    );
    return true;
  } catch (e) {
    toast(`添加附件失败：${e}`, "error");
    return false;
  }
}

export function PageAttachmentDrop({ pageId }: { pageId: string }) {
  const [hint, setHint] = useState<PageDropZone | null>(null);

  useEffect(() => {
    if (!pageId) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const zoneAt = (x: number, y: number) => resolveDropZone(document.elementFromPoint(x, y));
    const finish = (paths: string[], zone: PageDropZone) => {
      setHint(null);
      void importDroppedAttachments(pageId, paths, zone);
    };

    if (hasTauriShell()) {
      platform.webview
        .onDragDropEvent((event) => {
          // Tauri 的 over/drop 事件带 `position`（物理像素）；`leave` 不带。
          const payload = event.payload as unknown as {
            type?: string;
            paths?: string[];
            position?: { x: number; y: number };
          };
          const pt = toCssPoint(payload.position, window.devicePixelRatio || 1);
          const zone = pt ? zoneAt(pt.x, pt.y) : "editor";
          if (payload.type === "over") {
            setHint(zone);
            return;
          }
          if (payload.type === "leave") {
            setHint(null);
            return;
          }
          if (payload.type === "drop") finish(payload.paths ?? [], zone);
        })
        .then((fn) => {
          if (disposed) fn();
          else unlisten = fn;
        });
    } else {
      // Web 平台：HTML5 拖拽有 File 但没有**本地路径** ⇒ 诚实提示，不假装成功。
      const onOver = (e: DragEvent) => {
        if (!e.dataTransfer?.types?.includes("Files")) return;
        e.preventDefault();
        setHint(zoneAt(e.clientX, e.clientY));
      };
      const onLeave = () => setHint(null);
      const onDrop = (e: DragEvent) => {
        if (!(e.dataTransfer?.files?.length ?? 0)) return;
        e.preventDefault();
        setHint(null);
        toast("网页版暂不支持拖拽添加附件，请用附件面板按钮", "info");
      };
      window.addEventListener("dragover", onOver);
      window.addEventListener("dragleave", onLeave);
      window.addEventListener("drop", onDrop);
      return () => {
        disposed = true;
        window.removeEventListener("dragover", onOver);
        window.removeEventListener("dragleave", onLeave);
        window.removeEventListener("drop", onDrop);
      };
    }

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [pageId]);

  if (!hint) return null;
  return (
    <div className={`page-drop-overlay is-${hint}`} aria-hidden="true">
      <div className="page-drop-overlay-pill">{dropHintText(hint)}</div>
    </div>
  );
}
