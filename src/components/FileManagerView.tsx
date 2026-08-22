import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { useNotes } from "../store/notes";
import { useFileManagerStore } from "../store/fileManager";
import { api } from "../lib/api";
import { toast } from "../store/toast";
import type { AttachmentMeta, PageMeta } from "../types";
import { ChevronRightIcon, DatabaseIcon, FolderIcon, PageIcon } from "./icons";

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

function fileIcon(mime: string): string {
  if (mime.startsWith("image/")) return "🖼";
  if (mime.startsWith("video/")) return "🎬";
  if (mime.startsWith("audio/")) return "🎵";
  if (mime === "application/pdf") return "📕";
  if (mime.includes("zip") || mime.includes("gzip") || mime.includes("7z")) return "🗜";
  if (mime.includes("sheet") || mime.includes("excel") || mime === "text/csv") return "📊";
  if (mime.includes("word") || mime === "text/markdown") return "📄";
  if (mime.startsWith("text/")) return "📝";
  return "📎";
}

interface ImportProgressEvent {
  index: number;
  total: number;
  name: string;
  done: number;
  size: number;
}

const KIND_LABELS: Record<string, string> = {
  page: "页面",
  folder: "文件夹",
  database: "数据库",
};

function fmtDate(ms: number): string {
  if (!ms) return "—";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function KindIcon({ kind }: { kind: string }) {
  if (kind === "folder") return <FolderIcon />;
  if (kind === "database") return <DatabaseIcon />;
  return <PageIcon />;
}

// FlowUs-style file manager: browse the page/folder hierarchy as a table with
// type + modified/created columns, and create pages/folders inside a folder.
export function FileManagerView() {
  const { pages, openPage, createPage, createFolder } = useNotes();
  const { folderId, setFolderId } = useFileManagerStore();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [files, setFiles] = useState<AttachmentMeta[]>([]);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<{ name: string; percent: number } | null>(null);
  const importingRef = useRef(false);

  const loadFiles = () => {
    if (!folderId) {
      setFiles([]);
      return;
    }
    api
      .listPageAttachments(folderId)
      .then(setFiles)
      .catch(() => {});
  };
  useEffect(loadFiles, [folderId]);

  // Streaming import progress from the backend (content-addressed, large-file safe).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<ImportProgressEvent>("attachment-import-progress", (event) => {
      if (!importingRef.current) return;
      const p = event.payload;
      const current = p.size > 0 ? p.done / p.size : 1;
      const overall = ((p.index + current) / p.total) * 100;
      setProgress({ name: p.name, percent: Math.min(100, Math.round(overall)) });
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  const uploadFiles = async () => {
    if (!folderId) return;
    let selectedPath: string | string[] | null;
    try {
      selectedPath = await open({ multiple: true, title: "选择文件" });
    } catch (e) {
      toast(`选择文件失败：${e}`, "error");
      return;
    }
    const paths = Array.isArray(selectedPath) ? selectedPath : selectedPath ? [selectedPath] : [];
    if (paths.length === 0) return;

    setImporting(true);
    importingRef.current = true;
    setProgress({ name: paths[0] ?? "", percent: 0 });
    try {
      const metas = await api.importAttachmentFiles(folderId, paths);
      setFiles((prev) => [...metas, ...prev]);
      toast(`已上传 ${metas.length} 个文件`, "success");
    } catch (e) {
      toast(`上传失败：${e}`, "error");
    } finally {
      importingRef.current = false;
      setImporting(false);
      setProgress(null);
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
      setFiles((prev) => prev.filter((f) => f.id !== id));
      toast("已移除文件", "success");
    } catch (e) {
      toast(`移除失败：${e}`, "error");
    }
  };

  const all = useMemo(() => pages.filter((p) => !p.deleted_at), [pages]);
  const entries = useMemo(
    () => all.filter((p) => p.parent_id === folderId),
    [all, folderId],
  );

  // Folders first, then by title.
  const sorted = useMemo(
    () =>
      [...entries].sort((a, b) => {
        const ak = a.kind === "folder" ? 0 : 1;
        const bk = b.kind === "folder" ? 0 : 1;
        if (ak !== bk) return ak - bk;
        return (a.title || "").localeCompare(b.title || "", "zh");
      }),
    [entries],
  );

  // Breadcrumb chain from root to the current folder.
  const crumb = useMemo(() => {
    const chain: PageMeta[] = [];
    let cur = folderId ? all.find((p) => p.id === folderId) : undefined;
    while (cur) {
      chain.unshift(cur);
      cur = cur.parent_id ? all.find((p) => p.id === cur!.parent_id) : undefined;
    }
    return chain;
  }, [all, folderId]);

  const toggleSelect = (id: string) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const newFolder = () => createFolder(folderId);
  // createPage navigates to the editor with the new page already open.
  const newPage = () => createPage(folderId);

  return (
    <div className="file-manager">
      <div className="file-manager-head">
        <div className="file-manager-title-block">
          <span className="file-manager-bigicon">🗂</span>
          <h1 className="file-manager-title">文件管理</h1>
        </div>
        <div className="file-manager-actions">
          <button className="fm-btn" onClick={newFolder}>
            ＋ 新建文件夹
          </button>
          <button className="fm-btn fm-btn-primary" onClick={newPage}>
            ＋ 新建页面
          </button>
        </div>
      </div>

      <div className="file-manager-toolbar">
        <div className="fm-breadcrumb">
          <button
            className={`fm-crumb ${folderId === null ? "fm-crumb-active" : ""}`}
            onClick={() => setFolderId(null)}
          >
            全部
          </button>
          {crumb.map((c) => (
            <span key={c.id} className="fm-crumb-step">
              <ChevronRightIcon width={12} height={12} />
              <button
                className={`fm-crumb ${c.id === folderId ? "fm-crumb-active" : ""}`}
                onClick={() => setFolderId(c.id)}
              >
                {c.title || "未命名"}
              </button>
            </span>
          ))}
        </div>
        <span className="fm-count">{sorted.length} 项</span>
      </div>

      <div className="file-manager-table-wrap">
        <table className="file-manager-table">
          <thead>
            <tr>
              <th className="fm-check-col">
                <input type="checkbox" />
              </th>
              <th className="fm-name-col">文件名</th>
              <th className="fm-kind-col">类型</th>
              <th>上次修改时间</th>
              <th>创建时间</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((p) => (
              <tr
                key={p.id}
                className={selected.has(p.id) ? "fm-row-selected" : ""}
                onClick={() => toggleSelect(p.id)}
              >
                <td className="fm-check-col">
                  <input
                    type="checkbox"
                    checked={selected.has(p.id)}
                    onChange={() => toggleSelect(p.id)}
                    onClick={(e) => e.stopPropagation()}
                  />
                </td>
                <td className="fm-name-col">
                  <button
                    className="fm-name-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (p.kind === "folder") setFolderId(p.id);
                      else openPage(p.id);
                    }}
                  >
                    <span className="fm-kind-icon"><KindIcon kind={p.kind} /></span>
                    <span className="fm-name">{p.title || "未命名"}</span>
                  </button>
                </td>
                <td className="fm-kind-col">{KIND_LABELS[p.kind] ?? p.kind}</td>
                <td className="fm-date">{fmtDate(p.updated_at)}</td>
                <td className="fm-date">{fmtDate(p.created_at)}</td>
              </tr>
            ))}
            {sorted.length === 0 && (
              <tr>
                <td className="fm-empty" colSpan={5}>
                  {folderId === null ? "没有内容，点击右上角新建" : "此文件夹为空"}
                </td>
              </tr>
            )}
          </tbody>
        </table>

        {folderId && (
          <div className="fm-files">
            <div className="fm-files-head">
              <span className="fm-files-title">文件（{files.length}）</span>
              <button className="fm-btn" onClick={uploadFiles} disabled={importing}>
                {importing ? "上传中…" : "＋ 上传文件"}
              </button>
            </div>
            {progress && (
              <div className="fm-progress">
                <div className="fm-progress-label">
                  <span>上传：{progress.name}</span>
                  <span>{progress.percent}%</span>
                </div>
                <div className="fm-progress-track">
                  <div className="fm-progress-fill" style={{ width: `${progress.percent}%` }} />
                </div>
              </div>
            )}
            {files.length === 0 ? (
              <div className="fm-files-empty">
                从本机批量上传文件（支持超大文件流式存取，多选一次导入）
              </div>
            ) : (
              <div className="fm-files-list">
                {files.map((f) => (
                  <div key={f.id} className="fm-file-row">
                    <span className="fm-file-icon">{fileIcon(f.mime)}</span>
                    <span className="fm-file-name" title={f.name}>
                      {f.name}
                    </span>
                    <span className="fm-file-size">{formatSize(f.size)}</span>
                    <span className="fm-file-actions">
                      <button title="打开" onClick={() => openFile(f.path)}>
                        ↗
                      </button>
                      <button title="在文件夹中显示" onClick={() => revealFile(f.path)}>
                        📂
                      </button>
                      <button title="移除文件" onClick={() => removeFile(f.id)}>
                        ×
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
