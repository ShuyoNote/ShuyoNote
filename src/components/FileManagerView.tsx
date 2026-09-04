import { useEffect, useMemo, useRef, useState } from "react";
import { platform } from "../lib/platform";
import { useNotes } from "../store/notes";
import { useFileManagerStore } from "../store/fileManager";
import { confirmDialog } from "../store/confirm";
import { api } from "../lib/api";
import { toast } from "../store/toast";
import { usePdfReader } from "../store/pdfReader";
import { useFilePreview } from "../store/filePreview";
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
  const { pages, openPage, createPage, createFolder, deletePage } = useNotes();
  const { folderId, setFolderId } = useFileManagerStore();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [files, setFiles] = useState<AttachmentMeta[]>([]);
  const [importing, setImporting] = useState(false);
  const [fileQuery, setFileQuery] = useState("");
  const [dragging, setDragging] = useState(false);
  const [moving, setMoving] = useState<AttachmentMeta | null>(null);
  const [versionTarget, setVersionTarget] = useState<AttachmentMeta | null>(null);
  const [progress, setProgress] = useState<{ name: string; percent: number } | null>(null);
  const importingRef = useRef(false);
  const [viewMode, setViewMode] = useState<"list" | "grid">(
    () => (localStorage.getItem("shuyonote:fmView") as "list" | "grid") || "list",
  );
  const setView = (v: "list" | "grid") => {
    try { localStorage.setItem("shuyonote:fmView", v); } catch { /* ignore */ }
    setViewMode(v);
  };

  // folderId 为 null = 空间根：列出「未整理」文件（page_id IS NULL），
  // 而不是像以前那样直接清空——根下也允许上传，文件得有地方显示。
  const loadFiles = () => {
    api
      .listPageAttachments(folderId ?? null)
      .then(setFiles)
      .catch(() => {});
  };
  useEffect(loadFiles, [folderId]);

  // Streaming import progress from the backend (content-addressed, large-file safe).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    platform.event.listen<ImportProgressEvent>("attachment-import-progress", (event) => {
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
    let selectedPath: string | string[] | null;
    try {
      selectedPath = await platform.dialog.open({ multiple: true, title: "选择文件" });
    } catch (e) {
      toast(`选择文件失败：${e}`, "error");
      return;
    }
    const paths = Array.isArray(selectedPath) ? selectedPath : selectedPath ? [selectedPath] : [];
    if (paths.length === 0) return;
    await importPaths(paths);
  };

  const importPaths = async (paths: string[]) => {
    if (paths.length === 0) return;
    setImporting(true);
    importingRef.current = true;
    setProgress({ name: paths[0] ?? "", percent: 0 });
    try {
      // folderId 为 null 时传 null：文件落到空间根的「未整理」区，
      // 而不是被静默丢弃（此前根目录拖拽是直接 return）。
      const metas = await api.importAttachmentFiles(folderId ?? null, paths);
      setFiles((prev) => [...metas, ...prev]);
      useFileManagerStore.getState().bumpRevision();
      toast(`已上传 ${metas.length} 个文件`, "success");
    } catch (e) {
      toast(`上传失败：${e}`, "error");
    } finally {
      importingRef.current = false;
      setImporting(false);
      setProgress(null);
    }
  };

  // Drag OS files into an open folder to upload them (Tauri drag-drop event).
  useEffect(() => {
    const unlisten = platform.webview.onDragDropEvent((event) => {
      if (event.payload.type === "over") setDragging(true);
      else if (event.payload.type === "leave") setDragging(false);
      else if (event.payload.type === "drop") {
        setDragging(false);
        importPaths(event.payload.paths);
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderId]);

  const moveTo = async (f: AttachmentMeta, targetFolderId: string) => {
    if (targetFolderId === folderId) {
      setMoving(null);
      return;
    }
    try {
      await api.moveAttachment(f.id, targetFolderId);
      setFiles((prev) => prev.filter((x) => x.id !== f.id));
      toast("已移动", "success");
    } catch (e) {
      toast(`移动失败：${e}`, "error");
    }
    setMoving(null);
  };

  const openFile = async (path: string) => {
    if (!path) return;
    try {
      await platform.opener.openPath(path);
    } catch (e) {
      toast(`打开失败：${e}`, "error");
    }
  };
  const revealFile = async (path: string) => {
    if (!path) return;
    try {
      await platform.opener.revealItemInDir(path);
    } catch (e) {
      toast(`打开失败：${e}`, "error");
    }
  };
  const removeFile = async (id: string) => {
    if (
      !(await confirmDialog({
        title: "移除文件",
        message: "移除后，若该文件不再被任何页面/文件夹引用，其磁盘存储也会被清除。确定移除？",
        danger: true,
      }))
    ) {
      return;
    }
    try {
      await api.removeAttachment(id);
      setFiles((prev) => prev.filter((f) => f.id !== id));
      useFileManagerStore.getState().bumpRevision();
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

  // Unified file list: folders/pages/databases + uploaded files, as table rows.
  // Same-named files in a folder are grouped (the first = current, the rest are
  // implicitly content-addressed historical versions).
  const fileGroups = useMemo(() => {
    const map = new Map<string, AttachmentMeta[]>();
    for (const f of files) {
      const arr = map.get(f.name) ?? [];
      arr.push(f);
      map.set(f.name, arr);
    }
    const out: { current: AttachmentMeta; versions: AttachmentMeta[] }[] = [];
    for (const arr of map.values()) {
      out.push({ current: arr[0], versions: arr.slice(1) });
    }
    return out;
  }, [files]);

  const rows = useMemo(() => {
    type FmRow = {
      key: string;
      kind: "page" | "folder" | "database" | "file";
      name: string;
      size: string;
      updated: string;
      created: string;
      pageId?: string;
      cover?: string;
      file?: AttachmentMeta;
      versions?: AttachmentMeta[];
    };
    const out: FmRow[] = [];
    for (const p of sorted) {
      out.push({
        key: p.id,
        kind: p.kind as FmRow["kind"],
        name: p.title || (p.kind === "folder" ? "新建文件夹" : "未命名"),
        size: "—",
        updated: fmtDate(p.updated_at),
        created: fmtDate(p.created_at),
        pageId: p.id,
        cover: (p as unknown as { cover?: string }).cover ?? "",
      });
    }
    for (const g of fileGroups) {
      out.push({
        key: "file:" + g.current.id,
        kind: "file",
        name: g.current.name,
        size: formatSize(g.current.size),
        updated: "—",
        created: "—",
        file: g.current,
        versions: g.versions,
      });
    }
    return out;
  }, [sorted, fileGroups]);

  const selectedFileIds = useMemo(
    () => rows.filter((r) => r.kind === "file" && selected.has(r.key)).map((r) => r.file!.id),
    [rows, selected],
  );
  const selectedPageIds = useMemo(
    () => rows.filter((r) => r.kind !== "file" && selected.has(r.key)).map((r) => r.pageId!),
    [rows, selected],
  );
  const selectedCount = selected.size;

  // Select-all covers every visible row (pages / folders / databases / files).
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.key));

  const toggleSelectAll = () => {
    setSelected((s) => {
      const next = new Set(s);
      if (allSelected) {
        for (const r of rows) next.delete(r.key);
      } else {
        for (const r of rows) next.add(r.key);
      }
      return next;
    });
  };

  const batchRemove = async () => {
    if (selectedCount === 0) return;
    const fileCount = selectedFileIds.length;
    const pageCount = selectedPageIds.length;
    const parts: string[] = [];
    if (pageCount) parts.push(`${pageCount} 个页面/文件夹`);
    if (fileCount) parts.push(`${fileCount} 个文件`);
    if (!(await confirmDialog({
      title: "批量删除",
      message: `删除选中的 ${parts.join("、")}？${fileCount ? "文件若无引用其磁盘存储也会被清除。" : ""}`,
      danger: true,
    }))) {
      return;
    }
    try {
      // Delete pages/folders first (children then parents), then files.
      for (const pageId of selectedPageIds) {
        await deletePage(pageId);
      }
      if (fileCount > 0) {
        const n = await api.removeAttachments(selectedFileIds);
        setFiles((prev) => prev.filter((f) => !selectedFileIds.includes(f.id)));
        toast(`已删除 ${parts.join("、")}`, "success");
        if (n !== fileCount) {
          toast(`文件删除完成：${n} 个`, "info");
        }
      } else {
        toast(`已删除 ${pageCount} 个页面/文件夹`, "success");
      }
      setSelected(new Set());
      useFileManagerStore.getState().bumpRevision();
    } catch (e) {
      toast(`批量删除失败：${e}`, "error");
    }
  };

  const newFolder = () => createFolder(folderId);
  // createPage navigates to the editor with the new page already open.
  const newPage = () => createPage(folderId);

  // 打开一行（列表 / 网格共用）：图片/视频/音频/PDF 应用内预览，文件用系统应用，
  // 文件夹/页面进入。
  const openRow = (row: (typeof rows)[number]) => {
    if (row.kind === "file") {
      if (row.file!.mime === "application/pdf") {
        void usePdfReader.getState().openPdf(row.file!.id, row.file!.name);
      } else if (
        row.file!.mime === "text/markdown" ||
        row.file!.mime.startsWith("image/") ||
        row.file!.mime.startsWith("video/") ||
        row.file!.mime.startsWith("audio/")
      ) {
        useFilePreview.getState().open(row.file!);
      } else {
        toast("正在用系统默认应用打开…", "info");
        openFile(row.file!.path);
      }
    } else if (row.kind === "folder") {
      setFolderId(row.pageId!);
    } else {
      openPage(row.pageId!);
    }
  };

  // 网格视图按「照片/视频优先」排序（照片墙），页面/文件夹/其它文件靠后。
  const isMediaRow = (r: (typeof rows)[number]) =>
    r.kind === "file" && !!r.file && (r.file.mime.startsWith("image/") || r.file.mime.startsWith("video/"));
  const gridRows = useMemo(() => {
    const media = rows.filter(isMediaRow);
    const rest = rows.filter((r) => !isMediaRow(r));
    return [...media, ...rest];
  }, [rows]);

  const fileTotalBytes = useMemo(
    () => files.reduce((s, f) => s + (f.size || 0), 0),
    [files],
  );
  const q = fileQuery.trim().toLowerCase();
  const visibleRows = useMemo(
    () => (q ? rows.filter((r) => r.name.toLowerCase().includes(q)) : rows),
    [rows, q],
  );
  const folderTargets = useMemo(
    () => pages.filter((p) => p.kind === "folder" && p.id !== folderId),
    [pages, folderId],
  );

  const downloadFile = async (f: AttachmentMeta) => {
    const dest = await platform.dialog.save({ title: "保存文件", defaultPath: f.name });
    if (!dest) return;
    try {
      await api.copyAttachment(f.hash, dest);
      toast("已保存", "success");
    } catch (e) {
      toast(`下载失败：${e}`, "error");
    }
  };

  const restoreVersion = async (sourceId: string) => {
    if (!folderId) return;
    try {
      await api.restoreAttachment(folderId, sourceId);
      loadFiles();
      setVersionTarget(null);
      toast("已恢复到此版本", "success");
    } catch (e) {
      toast(`恢复失败：${e}`, "error");
    }
  };

  return (
    <div className="file-manager">
      <div className="file-manager-head">
        <div className="file-manager-title-block">
          <span className="file-manager-bigicon">
            <FolderIcon width={26} height={26} />
          </span>
          <h1 className="file-manager-title">文件管理</h1>
        </div>
        <div className="file-manager-actions">
          <button
            className="fm-btn fm-btn-danger"
            onClick={batchRemove}
            disabled={selectedCount === 0}
            title="删除选中的页面/文件夹/文件"
          >
            {selectedCount > 0 ? `删除所选 (${selectedCount})` : "删除所选"}
          </button>
          <button className="fm-btn" onClick={newFolder}>
            ＋ 新建文件夹
          </button>
          <button className="fm-btn" onClick={newPage}>
            ＋ 新建页面
          </button>
          <button
            className="fm-btn"
            onClick={uploadFiles}
            disabled={importing}
            title={folderId ? "批量上传文件" : "上传到空间根目录（未整理）"}
          >
            {importing ? "上传中…" : "＋ 上传文件"}
          </button>
          <div className="fm-view-toggle" role="group" aria-label="视图切换">
            <button
              className={`fm-view-btn${viewMode === "list" ? " is-on" : ""}`}
              title="列表"
              onClick={() => setView("list")}
            >☰</button>
            <button
              className={`fm-view-btn${viewMode === "grid" ? " is-on" : ""}`}
              title="网格（缩略图）"
              onClick={() => setView("grid")}
            >▦</button>
          </div>
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
        <span className="fm-count">
          {files.length} 个文件 · 共 {formatSize(fileTotalBytes)} · {visibleRows.length} 项
        </span>
        <input
          className="fm-search"
          placeholder="搜索文件…"
          value={fileQuery}
          onChange={(e) => setFileQuery(e.target.value)}
        />
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

      <div className="file-manager-table-wrap">
        {viewMode === "grid" && (
          <div className="fm-grid">
            {gridRows.length === 0 && <div className="fm-empty">没有文件</div>}
            {gridRows.map((row) => {
              const isImage = row.kind === "file" && row.file?.mime.startsWith("image/") && row.file.path;
              const isVideo = row.kind === "file" && row.file?.mime.startsWith("video/") && row.file.path;
              // 页面/数据库有 cover（题头图）时显示缩略图，否则小图标占位。
              const pageCover =
                row.kind !== "file" &&
                row.cover &&
                typeof row.cover === "string" &&
                !row.cover.startsWith("#") &&
                row.cover.length > 6 &&
                row.cover;
              return (
                <div
                  key={row.key}
                  className={`fm-grid-card${selected.has(row.key) ? " is-selected" : ""}`}
                  onClick={() => openRow(row)}
                >
                  <input
                    type="checkbox"
                    className="fm-grid-check"
                    checked={selected.has(row.key)}
                    onChange={() => toggleSelect(row.key)}
                    onClick={(e) => e.stopPropagation()}
                    title="选择"
                  />
                  {isImage ? (
                    <img
                      className="fm-grid-thumb"
                      src={platform.asset.convertFileSrc(row.file!.path)}
                      alt={row.name}
                      loading="lazy"
                    />
                  ) : isVideo ? (
                    <video
                      className="fm-grid-thumb"
                      src={platform.asset.convertFileSrc(row.file!.path)}
                      muted
                      preload="metadata"
                    />
                  ) : pageCover ? (
                    <img className="fm-grid-thumb" src={pageCover} alt={row.name} loading="lazy" />
                  ) : (
                    <span className="fm-grid-icon">
                      {row.kind === "file" ? fileIcon(row.file!.mime) : <KindIcon kind={row.kind} />}
                    </span>
                  )}
                  <div className="fm-grid-name">{row.name}</div>
                  {row.kind === "file" && folderId === null && (
                    <div className="fm-grid-tag">未整理</div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {viewMode === "list" && (
        <table className="file-manager-table">
          <thead>
            <tr>
              <th className="fm-check-col">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleSelectAll}
                  title="全选/取消全选"
                />
              </th>
              <th className="fm-name-col">文件名</th>
              <th className="fm-kind-col">类型</th>
              <th className="fm-size-col">大小</th>
              <th>上次修改时间</th>
              <th>创建时间</th>
              <th className="fm-ops-col" />
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row) => (
              <tr
                key={row.key}
                className={selected.has(row.key) ? "fm-row-selected" : ""}
                onClick={() => toggleSelect(row.key)}
              >
                <td className="fm-check-col">
                  <input
                    type="checkbox"
                    checked={selected.has(row.key)}
                    onChange={() => toggleSelect(row.key)}
                    onClick={(e) => e.stopPropagation()}
                  />
                </td>
                <td className="fm-name-col">
                  <button
                    className="fm-name-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      openRow(row);
                    }}
                  >
                    <span className="fm-kind-icon">
                      {row.kind === "file" ? fileIcon(row.file!.mime) : <KindIcon kind={row.kind} />}
                    </span>
                    <span className="fm-name">{row.name}</span>
                    {/* 根目录下的文件没有归属文件夹——明确标成「未整理」，
                        既解释了它为什么在这儿，也提示可以用 ↔ 移进文件夹。 */}
                    {row.kind === "file" && folderId === null && (
                      <span className="fm-inbox-tag">未整理</span>
                    )}
                  </button>
                </td>
                <td className="fm-kind-col">
                  {row.kind === "file" ? "文件" : KIND_LABELS[row.kind] ?? row.kind}
                </td>
                <td className="fm-size-col">{row.size}</td>
                <td className="fm-date">{row.updated}</td>
                <td className="fm-date">{row.created}</td>
                <td className="fm-ops-col">
                  {row.kind === "file" && (
                    <span className="fm-file-actions">
                      {/* M24 PDF 批注：直达阅读器，跳过预览层。openPdf 内自带 attachmentId+name。 */}
                      {row.file?.mime === "application/pdf" && (
                        <button
                          className="fm-file-annotate"
                          title="阅读并标注"
                          onClick={(e) => {
                            e.stopPropagation();
                            void usePdfReader.getState().openPdf(row.file!.id, row.file!.name);
                          }}
                        >
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                            <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
                            <path d="M14 3v6h6" />
                            <path d="M9 14l3-3 2.5 2.5-3 3z" />
                          </svg>
                        </button>
                      )}
                      {row.versions && row.versions.length > 0 && (
                        <button
                          title={`${row.versions.length + 1} 个历史版本`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setVersionTarget(row.file!);
                          }}
                        >
                          ↻
                        </button>
                      )}
                      <button
                        title="移动到文件夹"
                        onClick={(e) => {
                          e.stopPropagation();
                          setMoving(row.file!);
                        }}
                      >
                        ↔
                      </button>
                      <button
                        title="下载"
                        onClick={(e) => {
                          e.stopPropagation();
                          downloadFile(row.file!);
                        }}
                      >
                        ⬇
                      </button>
                      <button
                        title="在文件夹中显示"
                        onClick={(e) => {
                          e.stopPropagation();
                          revealFile(row.file!.path);
                        }}
                      >
                        📂
                      </button>
                      <button
                        title="移除文件"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeFile(row.file!.id);
                        }}
                      >
                        ×
                      </button>
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {visibleRows.length === 0 && (
              <tr>
                <td className="fm-empty" colSpan={7}>
                  {folderId === null
                    ? "还没有内容——新建页面/文件夹，或直接把文件拖进来（会放在根目录的「未整理」里）"
                    : "此文件夹为空，可上传文件"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        )}
      </div>

      {versionTarget && (
        <div className="fm-version-overlay" onClick={() => setVersionTarget(null)}>
          <div className="fm-version-pop" onClick={(e) => e.stopPropagation()}>
            <div className="fm-version-head">
              <span className="fm-version-title">「{versionTarget.name}」的历史版本</span>
              <button className="fm-version-close" title="关闭" onClick={() => setVersionTarget(null)}>
                ×
              </button>
            </div>
            <div className="fm-version-list">
              <div className="fm-version-item fm-version-current">
                <span className="fm-version-badge">当前</span>
                <span className="fm-version-name">{versionTarget.name}</span>
                <span className="fm-version-meta">{formatSize(versionTarget.size)}</span>
                <span className="fm-version-hash">#{versionTarget.hash.slice(0, 8)}</span>
              </div>
              {(fileGroups.find((g) => g.current.id === versionTarget.id)?.versions ?? []).map(
                (v, i) => (
                  <div key={v.id} className="fm-version-item">
                    <span className="fm-version-badge fm-version-old">v{fileGroups.find((g) => g.current.id === versionTarget.id)!.versions.length - i}</span>
                    <span className="fm-version-name">{v.name}</span>
                    <span className="fm-version-meta">{formatSize(v.size)}</span>
                    <span className="fm-version-hash">#{v.hash.slice(0, 8)}</span>
                    <button
                      className="fm-version-restore"
                      onClick={() => restoreVersion(v.id)}
                      title="恢复到此版本（作为当前文件）"
                    >
                      恢复
                    </button>
                  </div>
                ),
              )}
              {(fileGroups.find((g) => g.current.id === versionTarget.id)?.versions.length ?? 0) === 0 && (
                <div className="fm-version-empty">暂无更早版本</div>
              )}
            </div>
          </div>
        </div>
      )}

      {dragging && (
        <div className="fm-drop-zone">松开鼠标，上传到当前文件夹</div>
      )}

      {moving && (
        <div className="fm-move-popover">
          <div className="fm-move-title">移动「{moving.name}」到</div>
          {folderTargets.length === 0 ? (
            <div className="fm-move-empty">没有其他文件夹</div>
          ) : (
            folderTargets.map((f) => (
              <button
                key={f.id}
                className="fm-move-item"
                onClick={() => moveTo(moving, f.id)}
              >
                <FolderIcon width={14} height={14} />
                <span>{f.title || "未命名"}</span>
              </button>
            ))
          )}
          <button className="fm-move-item fm-move-cancel" onClick={() => setMoving(null)}>
            取消
          </button>
        </div>
      )}
    </div>
  );
}
