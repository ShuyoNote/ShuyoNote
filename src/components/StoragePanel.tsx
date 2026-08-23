import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { toast } from "../store/toast";
import { confirmDialog } from "../store/confirm";
import type { StorageStats } from "../types";

function fmt(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="storage-stat">
      <div className="storage-stat-value">{value}</div>
      <div className="storage-stat-label">{label}</div>
    </div>
  );
}

// Storage / space management: show where disk is used and run safe cleanups.
export function StoragePanel() {
  const [open, setOpen] = useState(false);
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => {
    api
      .storageStats()
      .then(setStats)
      .catch((e) => toast(`统计失败：${e}`, "error"));
  };
  useEffect(() => {
    if (open) refresh();
  }, [open]);

  const run = async (title: string, message: string, fn: () => Promise<number>, okLabel: string) => {
    if (!(await confirmDialog({ title, message, danger: true }))) return;
    setBusy(true);
    try {
      const freed = await fn();
      toast(`${okLabel}：释放 ${fmt(freed)}`, "success");
      await refresh();
    } catch (e) {
      toast(`操作失败：${e}`, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button className="btn-backup" title="存储 / 空间管理" onClick={() => setOpen((v) => !v)}>
        ▦
      </button>
      {open && (
        <div className="fm-version-overlay" onClick={() => setOpen(false)}>
          <div className="storage-panel" onClick={(e) => e.stopPropagation()}>
            <div className="storage-head">
              <span>存储 / 空间管理</span>
              <button className="storage-close" title="关闭" onClick={() => setOpen(false)}>
                ×
              </button>
            </div>
            {!stats ? (
              <div className="storage-loading">统计中…</div>
            ) : (
              <div className="storage-grid">
                <Stat label="数据库" value={fmt(stats.db_bytes)} />
                <Stat label={`附件 · ${stats.attachment_count} 个`} value={fmt(stats.attachment_bytes)} />
                <Stat label="回收站" value={`${stats.trash_count} 项 · ${fmt(stats.trash_bytes)}`} />
                <Stat label="版本历史" value={`${stats.version_count} 份 · ${fmt(stats.version_bytes)}`} />
                <Stat label="软删空间" value={String(stats.deleted_workspace_count)} />
                <Stat label="临时文件" value={fmt(stats.temp_bytes)} />
              </div>
            )}
            <div className="storage-actions">
              <button
                disabled={busy || !stats}
                onClick={() =>
                  run("清空回收站", "将永久删除回收站中的页面及其附件，不可撤销（建议先导出备份）。确定继续？", () => api.clearTrash(), "清空回收站")
                }
              >
                清空回收站（{stats?.trash_count ?? 0}）
              </button>
              <button
                disabled={busy || !stats}
                onClick={() =>
                  run("清理孤立附件", "将删除「无任何引用」的孤立附件字节（正在使用的文件不受影响）。确定继续？", () => api.cleanupOrphanAttachments(), "清理孤立附件")
                }
              >
                清理孤立附件
              </button>
              <button
                disabled={busy || !stats}
                onClick={() =>
                  run("清理旧版本", "每页仅保留最近 50 份版本历史，其余删除。确定继续？", () => api.cleanupOldVersions(50), "清理版本历史")
                }
              >
                清理旧版本历史
              </button>
              <button
                disabled={busy || !stats}
                onClick={() =>
                  run("清理临时文件", "删除备份/恢复临时目录与上传临时文件。确定继续？", () => api.cleanupTempFiles(), "清理临时文件")
                }
              >
                清理临时文件
              </button>
            </div>
            {busy && <div className="storage-busy">处理中…</div>}
          </div>
        </div>
      )}
    </>
  );
}
