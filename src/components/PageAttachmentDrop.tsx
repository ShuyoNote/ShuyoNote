// 外部文件拖拽：正文区 = 挂附件 + 插入正文卡片；附件区 = 只挂附件（owner 2026-11-09 选 A+）。
//
// ⭐ 2026-11-09 真机两轮定位（正文/附件区都拖不进去）：
//   ① 窗口创建时曾显式 `drag_and_drop(false)`（为让自绘标题栏能拖窗口）⇒ **tao 跳过
//      `OleInitialize`** ⇒ wry 的 `RegisterDragDrop` 失败（静默）⇒ Tauri 的 OS 拖拽事件
//      一条都收不到，HTML5 也被 `SetAllowExternalDrop(false)` 抑制 ⇒ 两条路同时死。
//   ② 现在**不再关**（默认 true）⇒ Tauri 事件会来；同时仍注册一份 HTML5 回退
//      （同一份落点判定；真机 Windows 上拿到的是 `File`，没有本地路径 ⇒ 按字节导入）。
//   两条路共用 400ms 去重：同一次松手只导一次。
//   Web 平台没有本地文件路径 ⇒ 明确提示走附件按钮（⛔ 不假装支持）。
import { useEffect, useState } from "react";
import { $getRoot } from "lexical";
import { platform } from "../lib/platform";
import { api } from "../lib/api";
import { toast } from "../store/toast";
import { useAttachmentsStore } from "../store/attachments";
import { useEditorStore } from "../store/editor";
import { $createAttachmentRefNode } from "../editor/nodes/AttachmentRefNode";
import {
  dropHintText,
  resolveDropZone,
  toCssPoint,
  type PageDropZone,
} from "../lib/pageAttachmentDrop";

/** 桌面壳是否可用（Web 平台没有本地路径 ⇒ 拖拽不可用，但仍给出可理解的提示）。 */
function hasTauriShell(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** 导入后：挂到当前页（可选）在正文插卡片 ＋ 刷新附件列表 ＋ toast。 */
function afterImported(metas: Array<{ id: string; name: string; size: number; mime: string; hash: string; path: string }>, zone: PageDropZone): void {
  if (metas.length === 0) {
    toast("没有可添加的附件", "info");
    return;
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
    afterImported(metas, zone);
    return true;
  } catch (e) {
    toast(`添加附件失败：${e}`, "error");
    return false;
  }
}

/**
 * ⭐ Windows 桌面兜底：拖进来的是 HTML5 `File`（没有本地路径）⇒ 读字节 → 算 sha256 →
 * 按字节导入（命令 `import_attachment_bytes`，语义与按路径导入相同）。
 */
export async function importDroppedFiles(
  pageId: string,
  files: File[],
  zone: PageDropZone,
): Promise<boolean> {
  if (files.length === 0) return false;
  try {
    const metas = [];
    for (const f of files) {
      const buf = await f.arrayBuffer();
      const meta = await api.importAttachmentBytes(
        pageId,
        f.name || "file",
        f.type || "application/octet-stream",
        Array.from(new Uint8Array(buf)),
      );
      metas.push(meta);
    }
    useAttachmentsStore.getState().bump();
    afterImported(metas, zone);
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
    const cleanups: Array<() => void> = [];
    // 同一次拖拽**只导一次**：Windows 上 Tauri 事件与 HTML5 回退可能同时到（两条路都在），
    // 用一个时间窗去重（400ms 足够覆盖同一次松手的两条回调）。
    let lastDropAt = 0;
    const accepted = () => {
      const now = Date.now();
      if (now - lastDropAt < 400) return false;
      lastDropAt = now;
      return true;
    };
    const zoneAt = (x: number, y: number) => resolveDropZone(document.elementFromPoint(x, y));
    const finishPaths = (paths: string[], zone: PageDropZone) => {
      setHint(null);
      if (!accepted()) return;
      void importDroppedAttachments(pageId, paths, zone);
    };
    const finishFiles = (files: File[], zone: PageDropZone) => {
      setHint(null);
      if (!accepted()) return;
      void importDroppedFiles(pageId, files, zone);
    };

    if (hasTauriShell()) {
      // ① Tauri 的 OS 拖拽事件（Windows 上 2026-11-09 起不再 `drag_and_drop(false)`，事件会来）。
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
          if (payload.type === "over" || payload.type === "enter") {
            setHint(zone);
            return;
          }
          if (payload.type === "leave") {
            setHint(null);
            return;
          }
          if (payload.type === "drop") finishPaths(payload.paths ?? [], zone);
        })
        .then((fn) => {
          if (disposed) fn();
          else cleanups.push(fn);
        })
        .catch((e: unknown) => {
          // ⛔ 不静默：监听注册失败（权限/API 变化）必须让用户看得见，否则就是"拖了没反应"。
          toast(`拖拽监听没起来（仍可用附件按钮）：${String(e)}`, "error");
        });

      // ② HTML5 拖拽回退（同一份落点判定）：某些配置下 Tauri 的 handler 装不上时还能用；
      //    真机上 Windows 走这条也拿到的是 `File`（没有路径）⇒ 按字节导入。
      //    捕获阶段：编辑器/其它控件可能在自己 handler 里 stopPropagation。
      const onEnterOrOver = (e: DragEvent) => {
        if (!e.dataTransfer?.types?.includes("Files")) return;
        e.preventDefault();
        setHint(zoneAt(e.clientX, e.clientY));
      };
      const onLeave = () => setHint(null);
      const onDrop = (e: DragEvent) => {
        const files = Array.from(e.dataTransfer?.files ?? []);
        if (files.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        finishFiles(files, zoneAt(e.clientX, e.clientY));
      };
      const onDragEnd = () => setHint(null);
      window.addEventListener("dragenter", onEnterOrOver, true);
      window.addEventListener("dragover", onEnterOrOver, true);
      window.addEventListener("dragleave", onLeave, true);
      window.addEventListener("drop", onDrop, true);
      window.addEventListener("dragend", onDragEnd, true);
      cleanups.push(() => {
        window.removeEventListener("dragenter", onEnterOrOver, true);
        window.removeEventListener("dragover", onEnterOrOver, true);
        window.removeEventListener("dragleave", onLeave, true);
        window.removeEventListener("drop", onDrop, true);
        window.removeEventListener("dragend", onDragEnd, true);
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
      cleanups.push(() => {
        window.removeEventListener("dragover", onOver);
        window.removeEventListener("dragleave", onLeave);
        window.removeEventListener("drop", onDrop);
      });
    }

    return () => {
      disposed = true;
      for (const fn of cleanups) fn();
    };
  }, [pageId]);

  if (!hint) return null;
  return (
    <div className={`page-drop-overlay is-${hint}`} aria-hidden="true">
      <div className="page-drop-overlay-pill">{dropHintText(hint)}</div>
    </div>
  );
}



