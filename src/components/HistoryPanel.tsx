import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { useNotes } from "../store/notes";
import { toast } from "../store/toast";
import { confirmDialog } from "../store/confirm";
import type { PageVersion } from "../types";
import { ClockIcon } from "./icons";

// Compact, friendly timestamp: today/yesterday → 时:分, this year → 月日 时:分, else 年月日.
function formatWhen(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (sameDay(d, now)) return `今天 ${hhmm}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return `昨天 ${hhmm}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${hhmm}`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hhmm}`;
}

export function HistoryPanel({ pageId }: { pageId: string }) {
  const { openPage, updateCurrent } = useNotes();
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<PageVersion[]>([]);
  const [loading, setLoading] = useState(false);
  const [clearing, setClearing] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    api
      .listVersions(pageId)
      .then(setVersions)
      .catch((e) => console.error(e))
      .finally(() => setLoading(false));
  }, [pageId]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);
  // 点击历史菜单以外区域关闭。
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest(".history-panel, .history-popover")) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const restore = async (versionId: string) => {
    if (!(await confirmDialog({ title: "恢复版本", message: "恢复到该版本？当前内容将被覆盖。" }))) return;
    try {
      const page = await api.restoreVersion(versionId);
      updateCurrent(page);
      setOpen(false);
      load();
      openPage(page.id);
      toast("已恢复该版本", "success");
    } catch (e) {
      toast(`恢复失败：${e}`, "error");
    }
  };

  // 一键清空（保留当前）：删除本页全部历史快照。
  const clearHistory = async () => {
    if (versions.length === 0) return;
    if (
      !(await confirmDialog({
        title: "清空版本历史",
        message: `将删除本页的全部 ${versions.length} 条历史版本（当前内容保留）。此操作不可撤销，确定继续？`,
      }))
    )
      return;
    setClearing(true);
    try {
      const n = await api.clearPageVersions(pageId);
      setVersions([]);
      toast(`已清空版本历史（删除 ${n} 条）`, "success");
    } catch (e) {
      toast(`清空失败：${e}`, "error");
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className="history-panel">
      <button
        className="toolbar-btn"
        onClick={() => setOpen((v) => !v)}
        title="版本历史"
        aria-label="版本历史"
      >
        <ClockIcon />
      </button>
      {open && (
        <div className="history-popover">
          <div className="history-head">
            <span className="history-title">版本历史</span>
            <span className="history-total">{loading ? "…" : `${versions.length} 个版本`}</span>
            <button
              className="history-clear"
              onClick={clearHistory}
              disabled={versions.length === 0 || clearing}
              title="删除全部历史版本（保留当前内容）"
            >
              {clearing ? "清空中…" : "清空"}
            </button>
          </div>
          {versions.length === 0 ? (
            <div className="history-empty">{loading ? "加载中…" : "暂无历史版本"}</div>
          ) : (
            versions.map((v, i) => (
              <div key={v.id} className="history-item">
                <div className="history-meta">
                  <div className="history-time-row">
                    <span className="history-time">{formatWhen(v.created_at)}</span>
                    {i === 0 && <span className="history-newest">最新</span>}
                  </div>
                  <span className="history-preview">{v.content_text.slice(0, 40) || "(空)"}</span>
                </div>
                <button className="history-restore" onClick={() => restore(v.id)}>
                  恢复
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
