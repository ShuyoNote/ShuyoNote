import { useEffect, useState } from "react";
import { usePopover } from "../hooks/usePopover";
import { api } from "../lib/api";
import { useNotes } from "../store/notes";
import { toast } from "../store/toast";
import { confirmDialog } from "../store/confirm";
import type { PageMeta } from "../types";
import { TrashIcon } from "./icons";

// 应用内 SVG 图标（避免引第三方）。
const RestoreIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M3 8a9 9 0 1 0 2.24-3.1" />
    <path d="M3 3v5h5" />
  </svg>
);

export function TrashPanel() {
  const { loadPages } = useNotes();
  const { open, pos, triggerRef, contentRef, toggle } = usePopover<HTMLButtonElement>();
  const [items, setItems] = useState<PageMeta[]>([]);

  const load = () => {
    api.listDeleted().then(setItems).catch(() => { /* 静默：面板刷新失败不打断 */ });
  };

  // 挂载即拉一次（触发图标显示数量角标）；打开面板再刷一次。
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (open) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const restore = async (id: string) => {
    try {
      await api.restorePage(id);
      load();
      await loadPages();
      toast("已恢复", "success");
    } catch (e) {
      toast(`恢复失败：${e}`, "error");
    }
  };

  const purge = async (id: string, title: string) => {
    if (!(await confirmDialog({ title: "彻底删除", message: `彻底删除「${title || "未命名"}」？此操作不可恢复。`, danger: true }))) return;
    try {
      await api.purgePage(id);
      load();
      toast("已彻底删除", "success");
    } catch (e) {
      toast(`删除失败：${e}`, "error");
    }
  };

  // 清空回收站（至少这个刚需功能）。
  const clearAll = async () => {
    if (!items.length) return;
    if (!(await confirmDialog({
      title: "清空回收站",
      message: `将永久删除回收站中的全部 ${items.length} 项页面及内容，不可恢复（建议先导出/备份）。确定继续？`,
      danger: true,
      okLabel: "清空",
    }))) return;
    try {
      await api.clearTrash();
      setItems([]);
      await loadPages();
      toast("回收站已清空", "success");
    } catch (e) {
      toast(`清空失败：${e}`, "error");
    }
  };

  return (
    <div className="trash-panel">
      {/* 图标尺寸与竖条其它项对齐（18px）。 */}
      <button ref={triggerRef} className="btn-trash" onClick={toggle} title="回收站" aria-label="回收站">
        <TrashIcon width={18} height={18} />
        {items.length > 0 && <span className="trash-badge">{items.length > 99 ? "99+" : items.length}</span>}
      </button>
      {open && (
        <div ref={contentRef} className="trash-popover" style={{ top: pos.top, left: pos.left, bottom: pos.bottom }}>
          <div className="trash-head">
            <span className="trash-head-title">回收站</span>
            <span className="trash-count">{items.length ? `${items.length} 项` : ""}</span>
            <button className="trash-clear" disabled={!items.length} onClick={clearAll} title="清空回收站">
              清空
            </button>
          </div>

          <div className="trash-list">
            {items.length === 0 ? (
              <div className="trash-empty">
                <span className="trash-empty-icon">🗑️</span>
                <span className="trash-empty-text">回收站为空</span>
                <span className="trash-empty-sub">删除的页面会先到这里，可随时恢复。</span>
              </div>
            ) : (
              items.map((p) => (
                <div key={p.id} className="trash-item">
                  <span className="trash-icon" aria-hidden>{p.kind === "folder" ? "📁" : "📄"}</span>
                  <span className="trash-title" title={p.title || "未命名"}>{p.title || "未命名"}</span>
                  <span className="trash-actions">
                    <button className="trash-act restore" title="恢复" onClick={() => restore(p.id)} aria-label={`恢复 ${p.title || "未命名"}`}>
                      <RestoreIcon size={13} /> 恢复
                    </button>
                    <button className="trash-act del" title="彻底删除" onClick={() => purge(p.id, p.title)} aria-label={`彻底删除 ${p.title || "未命名"}`}>
                      ✕
                    </button>
                  </span>
                </div>
              ))
            )}
          </div>

          {items.length > 0 && (
            <div className="trash-foot">
              <button className="trash-foot-clear" onClick={clearAll}>
                清空回收站
              </button>
              <span className="trash-foot-hint">永久删除，不可恢复</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
