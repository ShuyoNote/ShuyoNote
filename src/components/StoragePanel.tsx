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

interface PersistInfo {
  persisted: boolean;
  quota: number;
  usage: number;
  supported: boolean;
}

// Storage / space management: show where disk is used and run safe cleanups.
export function StoragePanel() {
  const [open, setOpen] = useState(false);
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [busy, setBusy] = useState(false);
  const [persist, setPersist] = useState<PersistInfo | null>(null);
  const [persistBusy, setPersistBusy] = useState(false);

  const refresh = () => {
    api
      .storageStats()
      .then(setStats)
      .catch((e) => toast(`统计失败：${e}`, "error"));
    api
      .requestPersistentStorage()
      .then((r) => setPersist({ persisted: r.persisted, quota: r.quota, usage: r.usage, supported: r.supported }))
      .catch(() => setPersist(null));
  };
  useEffect(() => {
    if (open) refresh();
  }, [open]);

  const requestPersist = async () => {
    setPersistBusy(true);
    try {
      const r = await api.requestPersistentStorage();
      setPersist({ persisted: r.persisted, quota: r.quota, usage: r.usage, supported: r.supported });
      toast(r.persisted ? "已启用持久化存储，浏览器将保留你的数据" : "浏览器未授予持久化存储", r.persisted ? "success" : "info");
    } catch (e) {
      toast(`持久化存储失败：${e}`, "error");
    } finally {
      setPersistBusy(false);
    }
  };

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
            <div className="storage-persist">
              <div className="storage-persist-label">
                {!persist ? (
                  <span>持久化状态：…</span>
                ) : !persist.supported ? (
                  <span>持久化状态：此浏览器不支持</span>
                ) : persist.persisted ? (
                  <span>持久化状态：<b className="storage-persist-on">已启用</b>（{fmt(persist.usage)} / {fmt(persist.quota)}）</span>
                ) : (
                  <span>持久化状态：<b className="storage-persist-off">未启用</b>（{fmt(persist.usage)} / {fmt(persist.quota)}）</span>
                )}
              </div>
              <button className="storage-persist-btn" disabled={persistBusy || !persist?.supported} onClick={requestPersist}>
                {persistBusy ? "请求中…" : persist?.persisted ? "已请求持久化" : "启用持久化"}
              </button>
            </div>
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
              <button
                disabled={busy || !stats}
                onClick={async () => {
                  if (!(await confirmDialog({ title: "清理软删工作空间", message: "将永久删除所有「已软删工作空间」及其整个页面树（建议先导出备份），不可撤销。确定继续？", danger: true }))) return;
                  setBusy(true);
                  try {
                    const r = await api.purgeDeletedWorkspaces();
                    toast(`清理软删工作空间：删除 ${r.workspaces} 个，释放 ${fmt(r.freed)}`, "success");
                    await refresh();
                  } catch (e) {
                    toast(`操作失败：${e}`, "error");
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                清理软删工作空间（{stats?.deleted_workspace_count ?? 0}）
              </button>
            </div>
            {busy && <div className="storage-busy">处理中…</div>}
          </div>
        </div>
      )}
    </>
  );
}
