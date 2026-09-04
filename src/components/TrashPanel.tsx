import { useEffect, useState } from "react";
import { usePopover } from "../hooks/usePopover";
import { api } from "../lib/api";
import { useNotes } from "../store/notes";
import { toast } from "../store/toast";
import { confirmDialog } from "../store/confirm";
import type { PageMeta } from "../types";
import { TrashIcon } from "./icons";

// 相对时间：最近用「几分钟前」，超一周显示日期。
function formatWhen(ts?: number | null): string {
  if (!ts) return "";
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} 天前`;
  const dt = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}/${dt.getMonth() + 1}/${dt.getDate()} ${p(dt.getHours())}:${p(dt.getMinutes())}`;
}

// 应用内 SVG 图标。
const RestoreIcon = ({ size = 13 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M3 8a9 9 0 1 0 2.24-3.1" />
    <path d="M3 3v5h5" />
  </svg>
);

function ItemIcon({ kind }: { kind: string }) {
  return <span className="trash-icon" aria-hidden>{kind === "folder" ? "📁" : "📄"}</span>;
}

export function TrashPanel() {
  const { loadPages } = useNotes();
  const { open, pos, triggerRef, contentRef, toggle } = usePopover<HTMLButtonElement>();
  const [items, setItems] = useState<PageMeta[]>([]);

  const load = () => {
    api.listDeleted().then(setItems).catch(() => { /* 静默 */ });
  };

  // 挂载即拉一次（触发图标数量角标）；打开再刷一次。
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

  // 一键恢复全部。
  const restoreAll = async () => {
    if (!items.length) return;
    if (!(await confirmDialog({
      title: "恢复全部",
      message: `将恢复回收站中的全部 ${items.length} 项页面/文件夹。确定恢复？`,
      okLabel: "恢复",
    }))) return;
    try {
      for (const p of items) await api.restorePage(p.id);
      setItems([]);
      await loadPages();
      toast(`已恢复全部 ${items.length} 项`, "success");
    } catch (e) {
      toast(`恢复失败：${e}`, "error");
    }
  };

  // 按类型分组：文件夹在前、页面在后；只有一种类型时不显示分组头。
  const folders = items.filter((i) => i.kind === "folder");
  const pages = items.filter((i) => i.kind !== "folder");

  const renderGroup = (label: string, list: PageMeta[]) =>
    list.length > 0 && (
      <>
        <div className="trash-group-label">{label}</div>
        {list.map((p) => (
          <div key={p.id} className="trash-item">
            <ItemIcon kind={p.kind} />
            <div className="trash-item-main">
              <span className="trash-title" title={p.title || "未命名"}>{p.title || "未命名"}</span>
              <span className="trash-when">{formatWhen(p.deleted_at) ? `删除于 ${formatWhen(p.deleted_at)}` : ""}</span>
            </div>
            <span className="trash-actions">
              <button className="trash-act restore" title="恢复" onClick={() => restore(p.id)} aria-label={`恢复 ${p.title || "未命名"}`}>
                <RestoreIcon size={13} /> 恢复
              </button>
              <button className="trash-act del" title="彻底删除" onClick={() => purge(p.id, p.title)} aria-label={`彻底删除 ${p.title || "未命名"}`}>
                ✕
              </button>
            </span>
          </div>
        ))}
      </>
    );

  return (
    <div className="trash-panel">
      <button ref={triggerRef} className="btn-trash" onClick={toggle} title="回收站" aria-label="回收站">
        <TrashIcon width={18} height={18} />
        {items.length > 0 && <span className="trash-badge">{items.length > 99 ? "99+" : items.length}</span>}
      </button>
      {open && (
        <div ref={contentRef} className="trash-popover" style={{ top: pos.top, left: pos.left, bottom: pos.bottom }}>
          <div className="trash-head">
            <span className="trash-head-title">回收站</span>
            <span className="trash-count">{items.length ? `${items.length} 项` : ""}</span>
            <span className="trash-head-actions">
              <button className="trash-act-head restore" disabled={!items.length} onClick={restoreAll} title="恢复全部">
                <RestoreIcon size={12} /> 恢复全部
              </button>
              <button className="trash-act-head clear" disabled={!items.length} onClick={clearAll} title="清空回收站">
                清空
              </button>
            </span>
          </div>

          <div className="trash-list">
            {items.length === 0 ? (
              <div className="trash-empty">
                <span className="trash-empty-icon">🗑️</span>
                <span className="trash-empty-text">回收站为空</span>
                <span className="trash-empty-sub">删除的页面会先到这里，可随时恢复。</span>
              </div>
            ) : (
              <>
                {renderGroup("文件夹", folders)}
                {renderGroup("页面", pages)}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
