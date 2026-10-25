import { useEffect, useRef, useState } from "react";
import { platform } from "../lib/platform";
import { api } from "../lib/api";
import { toast } from "../store/toast";
import { useAttachmentsStore } from "../store/attachments";
import { useSpaceStore } from "../store/space";
import { usePdfReader } from "../store/pdfReader";
import type { AttachmentMeta } from "../types";

interface ImportProgressEvent {
  index: number;
  total: number;
  name: string;
  done: number;
  size: number;
}

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
  const [progress, setProgress] = useState<{ name: string; percent: number } | null>(null);
  const importingRef = useRef(false);
  const revision = useAttachmentsStore((s) => s.revision);

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
  }, [pageId, revision]);

  // Listen to streaming import progress emitted from the backend.
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

  // ⭐ 2026-10-25（owner：「点击侧边栏的项目，不能触发下载吗？」）：
  //   打开页面（含 folder 页）时，**自动把该页缺失的附件字节**按需取回来，
  //   不用再逐个点开预览。只做一轮、有预算上限（64 MB），失败静默（用户仍可手点）。
  const prefetchStarted = useRef(false);
  const prefetchAttempted = useRef<Set<string>>(new Set());
  const [prefetching, setPrefetching] = useState<{ done: number; total: number } | null>(null);
  useEffect(() => {
    prefetchStarted.current = false;
    prefetchAttempted.current.clear();
    setPrefetching(null);
  }, [pageId]);
  useEffect(() => {
    if (prefetchStarted.current) return;
    if (typeof api.downloadAttachment !== "function") return;
    const wsId = useSpaceStore.getState().activeId;
    if (!wsId) return;
    const budget = 64 * 1024 * 1024;
    const missing: AttachmentMeta[] = [];
    let total = 0;
    for (const a of attachments) {
      if (a.path || prefetchAttempted.current.has(a.hash)) continue;
      if (a.size > budget || total + a.size > budget) continue;
      total += a.size;
      missing.push(a);
    }
    if (missing.length === 0) return;
    prefetchStarted.current = true;
    let cancelled = false;
    setPrefetching({ done: 0, total: missing.length });
    void (async () => {
      for (let i = 0; i < missing.length; i++) {
        if (cancelled) return;
        prefetchAttempted.current.add(missing[i].hash);
        try {
          await api.downloadAttachment(wsId, missing[i].hash);
        } catch {
          // 对端/服务器不在线是常态；这里静默，用户点开文件时还会再试一次并给提示。
        }
        if (!cancelled) setPrefetching({ done: i + 1, total: missing.length });
      }
      if (!cancelled) {
        setPrefetching(null);
        useAttachmentsStore.getState().bump();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attachments]);

  const addFiles = async () => {
    let selected: string | string[] | null;
    try {
      selected = await platform.dialog.open({ multiple: true, title: "选择文件" });
    } catch (e) {
      toast(`选择文件失败：${e}`, "error");
      return;
    }
    const paths = Array.isArray(selected) ? selected : selected ? [selected] : [];
    if (paths.length === 0) return;

    setImporting(true);
    importingRef.current = true;
    setProgress({ name: paths[0] ?? "", percent: 0 });
    try {
      const metas = await api.importAttachmentFiles(pageId, paths);
      setAttachments((prev) => [...metas, ...prev]);
      useAttachmentsStore.getState().bump();
      toast(`已添加 ${metas.length} 个文件`, "success");
    } catch (e) {
      toast(`添加失败：${e}`, "error");
    } finally {
      importingRef.current = false;
      setImporting(false);
      setProgress(null);
    }
  };

  const openFile = async (a: AttachmentMeta) => {
    // PDF 附件：不是用默认程序打开，而是直接进内置阅读器做批注/阅读。
    if (a.mime === "application/pdf") {
      void usePdfReader.getState().openPdf(a.id, a.name);
      return;
    }
    if (!a.path) return;
    try {
      await platform.opener.openPath(a.path);
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
    try {
      // ⭐ 2026-10-12（owner 拍：**幂等但如实返回"删了 0 条"**）：这条命令现在回**实际删掉的条数** ✓
      //    （`1` = 真删到 / `0` = 本来就没这一行 ⇒ ⛔ 不报错 ✓）⇒ 提示由界面**自己决定** ✓。
      const removed = await api.removeAttachment(id);
      setAttachments((prev) => prev.filter((a) => a.id !== id));
      // ⭐ 与文件管理器**同一口径**（`FileManagerView.tsx` 的 `loadFiles()`）：**不许只信本地那个 filter** ✗
      //    —— `0` 条那条路下后端什么都没删 ⇒ 让面板重列一次，那一行会**如实**待在那儿 ✓
      //    （`useAttachmentsStore.revision` 一变，上面 `:48-59` 那个 effect 就重取 ✓）。
      useAttachmentsStore.getState().bump();
      if (removed === 0) {
        // 幂等不是错，但⛔不许假装删掉了 ✗。
        toast("这个附件已经不在列表里了", "info");
      } else {
        toast("已移除附件", "success");
      }
    } catch (e) {
      toast(`移除失败：${e}`, "error");
    }
  };

  // Don't occupy fixed display space when the page has no attachments — only show
  // the panel once there's something to show (or while importing).
  if (attachments.length === 0 && !importing) return null;

  return (
    <div className="attachment-panel">
      <div className="attachment-head">
        <span className="attachment-title">附件</span>
        {prefetching && (
          <span className="attachment-prefetch">
            正在取回文件 {prefetching.done}/{prefetching.total}…
          </span>
        )}
        <button className="attachment-add" onClick={addFiles} disabled={importing}>
          {importing ? "导入中…" : "＋ 添加文件"}
        </button>
      </div>
      {progress && (
        <div className="attachment-progress">
          <div className="attachment-progress-label">
            <span>导入中：{progress.name}</span>
            <span>{progress.percent}%</span>
          </div>
          <div className="attachment-progress-track">
            <div className="attachment-progress-fill" style={{ width: `${progress.percent}%` }} />
          </div>
        </div>
      )}
      {attachments.length === 0 ? (
        <div className="attachment-empty">暂无附件，点击「添加文件」从本机导入（支持超大文件流式存取）</div>
      ) : (
        <div className="attachment-list">
          {attachments.map((a) => (
            <div key={a.id} className="attachment-item">
              <span className="attachment-icon">{iconFor(a.mime)}</span>
              <div className="attachment-meta">
                <span className="attachment-name" title={a.name} onClick={() => openFile(a)}>
                  {a.name}
                </span>
                <span className="attachment-size">{formatSize(a.size)}</span>
              </div>
              <div className="attachment-actions">
                <button title={a.mime === "application/pdf" ? "在阅读器中打开批注" : "打开"} onClick={() => openFile(a)}>
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
