import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useNotes } from "../store/notes";
import { toast } from "../store/toast";
import { confirmDialog } from "../store/confirm";
import type { PageVersion } from "../types";
import { ClockIcon } from "./icons";

function formatTime(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleString();
}

export function HistoryPanel({ pageId }: { pageId: string }) {
  const { openPage, updateCurrent } = useNotes();
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<PageVersion[]>([]);

  useEffect(() => {
    if (open) {
      api.listVersions(pageId).then(setVersions).catch((e) => console.error(e));
    }
  }, [open, pageId]);
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
      openPage(page.id);
      toast("已恢复该版本", "success");
    } catch (e) {
      toast(`恢复失败：${e}`, "error");
    }
  };

  return (
    <div className="history-panel">
      <button className="toolbar-btn" onClick={() => setOpen((v) => !v)} title="版本历史">
        <ClockIcon />
      </button>
      {open && (
        <div className="history-popover">
          {versions.length === 0 ? (
            <div className="history-empty">暂无历史版本</div>
          ) : (
            versions.map((v) => (
              <div key={v.id} className="history-item">
                <div className="history-meta">
                  <span className="history-time">{formatTime(v.created_at)}</span>
                  <span className="history-preview">
                    {v.content_text.slice(0, 40) || "(空)"}
                  </span>
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
