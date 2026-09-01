import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../lib/api";
import { toast } from "../store/toast";
import { confirmDialog } from "../store/confirm";
import { DatabaseIcon } from "./icons";
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

interface PersistInfo {
  persisted: boolean;
  quota: number;
  usage: number;
  supported: boolean;
}

// 存储构成的分段：颜色与「占比条 → 图例 → 明细」三处共用同一份定义，
// 避免颜色和口径在三个地方各写一遍走样。
interface Segment {
  key: string;
  label: string;
  bytes: number;
  color: string;
  detail?: string;
}

// Storage / space management: show where disk is used and run safe cleanups.
// `label` 同 BackupButton：空=侧栏小图标；有值=设置中心「数据」页的文字按钮。
export function StoragePanel({ label }: { label?: string } = {}) {
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

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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

  const segments = useMemo<Segment[]>(() => {
    if (!stats) return [];
    return [
      { key: "db", label: "数据库", bytes: stats.db_bytes, color: "var(--cat-blue)" },
      {
        key: "att",
        label: "附件",
        bytes: stats.attachment_bytes,
        color: "var(--cat-green)",
        detail: `${stats.attachment_count} 个文件`,
      },
      {
        key: "trash",
        label: "回收站",
        bytes: stats.trash_bytes,
        color: "var(--cat-orange)",
        detail: `${stats.trash_count} 项`,
      },
      {
        key: "ver",
        label: "版本历史",
        bytes: stats.version_bytes,
        color: "var(--cat-purple)",
        detail: `${stats.version_count} 份`,
      },
      { key: "tmp", label: "临时文件", bytes: stats.temp_bytes, color: "var(--cat-gray)" },
    ];
  }, [stats]);

  const total = segments.reduce((s, x) => s + Math.max(0, x.bytes), 0);
  // 可回收 = 回收站 + 版本历史 + 临时文件（正在用的数据库与附件不算）。
  const reclaimable = stats ? stats.trash_bytes + stats.version_bytes + stats.temp_bytes : 0;

  return (
    <>
      <button
        className={label ? "set-btn" : "btn-backup"}
        title="存储 / 空间管理"
        aria-label="存储 / 空间管理"
        onClick={() => setOpen((v) => !v)}
      >
        {label ?? <DatabaseIcon width={15} height={15} />}
      </button>
      {open &&
        createPortal(
          <div
            className="stg-overlay"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setOpen(false);
            }}
          >
            <div className="stg-panel" role="dialog" aria-label="存储与空间管理" aria-modal="true">
              <header className="stg-head">
                <div className="stg-head-text">
                  <div className="stg-title">存储 / 空间管理</div>
                  <div className="stg-sub">看清空间被谁占用，并安全回收；正在使用的数据不会被动。</div>
                </div>
                <button className="stg-close" title="关闭" aria-label="关闭" onClick={() => setOpen(false)}>
                  ×
                </button>
              </header>

              <div className="stg-body">
                {!stats ? (
                  <div className="stg-loading">统计中…</div>
                ) : (
                  <>
                    <section className="stg-section">
                      <div className="stg-total-row">
                        <div className="stg-total">
                          <span className="stg-total-value">{fmt(total)}</span>
                          <span className="stg-total-label">当前空间合计</span>
                        </div>
                        {reclaimable > 0 && (
                          <div className="stg-reclaim">
                            可回收约 <b>{fmt(reclaimable)}</b>
                          </div>
                        )}
                      </div>

                      {/* 占比条：一眼看出「谁占的」，比五个孤立数字有用得多。 */}
                      <div className="stg-bar" role="img" aria-label="存储构成占比">
                        {segments
                          .filter((s) => s.bytes > 0)
                          .map((s) => (
                            <span
                              key={s.key}
                              className="stg-bar-seg"
                              style={{ width: `${(s.bytes / Math.max(1, total)) * 100}%`, background: s.color }}
                              title={`${s.label} ${fmt(s.bytes)}`}
                            />
                          ))}
                        {total === 0 && <span className="stg-bar-empty" />}
                      </div>

                      <div className="stg-legend">
                        {segments.map((s) => (
                          <div key={s.key} className="stg-legend-item">
                            <span className="stg-dot" style={{ background: s.color }} />
                            <span className="stg-legend-label">{s.label}</span>
                            <span className="stg-legend-value">
                              {fmt(s.bytes)}
                              {s.detail && <span className="stg-legend-detail"> · {s.detail}</span>}
                            </span>
                          </div>
                        ))}
                      </div>
                    </section>

                    {persist && persist.supported && (
                      <section className="stg-section">
                        <div className="stg-section-title">浏览器持久化</div>
                        <div className="stg-row">
                          <div className="stg-row-text">
                            <div className="stg-row-name">
                              {persist.persisted ? "已启用" : "未启用"}
                              <span className="stg-row-quota">
                                {fmt(persist.usage)} / {fmt(persist.quota)}
                              </span>
                            </div>
                            <div className="stg-row-sub">
                              未启用时，浏览器在磁盘紧张时可能清理本站数据（笔记会丢）。
                            </div>
                          </div>
                          <button className="stg-btn" disabled={persistBusy || persist.persisted} onClick={requestPersist}>
                            {persistBusy ? "请求中…" : persist.persisted ? "已启用" : "启用持久化"}
                          </button>
                        </div>
                      </section>
                    )}

                    {/* 清理都是不可逆操作，统一放危险区并逐条说明影响范围。 */}
                    <section className="stg-section stg-danger">
                      <div className="stg-section-title stg-danger-title">清理与回收（不可逆）</div>
                      <div className="stg-row">
                        <div className="stg-row-text">
                          <div className="stg-row-name">清空回收站</div>
                          <div className="stg-row-sub">
                            {stats.trash_count} 项 · {fmt(stats.trash_bytes)}，删除后无法从应用内恢复
                          </div>
                        </div>
                        <button
                          className="stg-btn is-danger"
                          disabled={busy || !stats.trash_count}
                          onClick={() =>
                            run("清空回收站", "将永久删除回收站中的页面及其附件，不可撤销（建议先导出备份）。确定继续？", () => api.clearTrash(), "清空回收站")
                          }
                        >
                          清空
                        </button>
                      </div>
                      <div className="stg-row">
                        <div className="stg-row-text">
                          <div className="stg-row-name">清理孤立附件</div>
                          <div className="stg-row-sub">删除无任何引用的附件字节；正在使用的文件不受影响</div>
                        </div>
                        <button
                          className="stg-btn is-danger"
                          disabled={busy}
                          onClick={() =>
                            run("清理孤立附件", "将删除「无任何引用」的孤立附件字节（正在使用的文件不受影响）。确定继续？", () => api.cleanupOrphanAttachments(), "清理孤立附件")
                          }
                        >
                          清理
                        </button>
                      </div>
                      <div className="stg-row">
                        <div className="stg-row-text">
                          <div className="stg-row-name">清理旧版本历史</div>
                          <div className="stg-row-sub">
                            {stats.version_count} 份 · {fmt(stats.version_bytes)}，每页仅保留最近 50 份
                          </div>
                        </div>
                        <button
                          className="stg-btn is-danger"
                          disabled={busy || !stats.version_count}
                          onClick={() =>
                            run("清理旧版本", "每页仅保留最近 50 份版本历史，其余删除。确定继续？", () => api.cleanupOldVersions(50), "清理版本历史")
                          }
                        >
                          清理
                        </button>
                      </div>
                      <div className="stg-row">
                        <div className="stg-row-text">
                          <div className="stg-row-name">清理临时文件</div>
                          <div className="stg-row-sub">备份/恢复临时目录与上传临时文件 · {fmt(stats.temp_bytes)}</div>
                        </div>
                        <button
                          className="stg-btn is-danger"
                          disabled={busy || !stats.temp_bytes}
                          onClick={() =>
                            run("清理临时文件", "删除备份/恢复临时目录与上传临时文件。确定继续？", () => api.cleanupTempFiles(), "清理临时文件")
                          }
                        >
                          清理
                        </button>
                      </div>
                      <div className="stg-row">
                        <div className="stg-row-text">
                          <div className="stg-row-name">清理软删工作空间</div>
                          <div className="stg-row-sub">
                            {stats.deleted_workspace_count} 个已软删空间及其整个页面树，删除后不可恢复
                          </div>
                        </div>
                        <button
                          className="stg-btn is-danger"
                          disabled={busy || !stats.deleted_workspace_count}
                          onClick={async () => {
                            if (
                              !(await confirmDialog({
                                title: "清理软删工作空间",
                                message: "将永久删除所有「已软删工作空间」及其整个页面树（建议先导出备份），不可撤销。确定继续？",
                                danger: true,
                              }))
                            )
                              return;
                            setBusy(true);
                            try {
                              const r = await api.purgeDeletedWorkspaces();
                              toast(`清理软删工作空间：删除 ${r.workspaces} 个，释放 ${fmt(r.freed)}`, "success");
                              refresh();
                            } catch (e) {
                              toast(`操作失败：${e}`, "error");
                            } finally {
                              setBusy(false);
                            }
                          }}
                        >
                          清理
                        </button>
                      </div>
                    </section>
                  </>
                )}
              </div>

              {busy && <div className="stg-busy">处理中…</div>}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
