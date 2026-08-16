import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { api } from "../lib/api";
import { toast } from "../store/toast";
import type { AttachmentMeta } from "../types";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(1)} ${units[i]}`;
}

function iconFor(mime: string): string {
  if (mime.startsWith("image/")) return "🖼";
  if (mime.startsWith("video/")) return "🎬";
  if (mime.startsWith("audio/")) return "🎵";
  if (mime === "application/pdf") return "📕";
  if (mime.includes("zip") || mime.includes("gzip") || mime.includes("7z")) return "🗜";
  if (mime.includes("sheet") || mime.includes("excel") || mime === "text/csv") return "📊";
  if (mime.includes("word") || mime === "text/plain" || mime === "text/markdown") return "📄";
  if (mime.startsWith("text/")) return "📝";
  return "📎";
}

export function AttachmentPanel({ pageId }: { pageId: string }) {
  const [attachments, setAttachments] = useState<AttachmentMeta[]>([]);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .listPageAttachments(pageId)
      .then((list) => {
        if (alive) setAttachments(list);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [pageId]);

  const addFiles = async () => {
    let selected: string | string[] | null;
    try {
      selected = await open({ multiple: true, title: "选择文件" });
    } catch (e) {
      toast(`选择文件失败：${e}`, "error");
      return;
    }
    const paths = Array.isArray(selected) ? selected : selected ? [selected] : [];
    if (paths.length === 0) return;

    setImporting(true);
    try {
      const metas = await api.importAttachmentFiles(pageId, paths);
      setAttachments((prev) => [...metas, ...prev]);
      toast(`已添加 ${metas.length} 个文件`, "success");
    } catch (e) {
      toast(`添加失败：${e}`, "error");
    } finally {
      setImporting(false);
    }
  };

  const openFile = async (path: string) => {
    if (!path) return;
    try {
      await openPath(path);
    } catch (e) {
      toast(`打开失败：${e}`, "error");
    }
  };

  const revealFile = async (path: string) => {
    if (!path) return;
    try {
      await revealItemInDir(path);
    } catch (e) {
      toast(`打开失败：${e}`, "error");
    }
  };

  const removeFile = async (id: string) => {
    try {
      await api.removeAttachment(id);
      setAttachments((prev) => prev.filter((a) => a.id !== id));
      toast("已移除附件", "success");
    } catch (e) {
      toast(`移除失败：${e}`, "error");
    }
  };

  return (
    <div className="attachment-panel">
      <div className="attachment-head">
        <span className="attachment-title">附件</span>
        <button className="attachment-add" onClick={addFiles} disabled={importing}>
          {importing ? "导入中…" : "＋ 添加文件"}
        </button>
      </div>
      {attachments.length === 0 ? (
        <div className="attachment-empty">暂无附件，点击「添加文件」从本机导入（支持超大文件流式存取）</div>
      ) : (
        <div className="attachment-list">
          {attachments.map((a) => (
            <div key={a.id} className="attachment-item">
              <span className="attachment-icon">{iconFor(a.mime)}</span>
              <div className="attachment-meta">
                <span className="attachment-name" title={a.name}>
                  {a.name}
                </span>
                <span className="attachment-size">{formatSize(a.size)}</span>
              </div>
              <div className="attachment-actions">
                <button title="打开" onClick={() => openFile(a.path)}>
                  ↗
                </button>
                <button title="在文件夹中显示" onClick={() => revealFile(a.path)}>
                  📂
                </button>
                <button title="移除附件" onClick={() => removeFile(a.id)}>
                  ×
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
