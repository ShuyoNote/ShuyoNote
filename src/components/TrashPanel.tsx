import { useEffect, useState } from "react";
import { usePopover } from "../hooks/usePopover";
import { api } from "../lib/api";
import { useNotes } from "../store/notes";
import { toast } from "../store/toast";
import { confirmDialog } from "../store/confirm";
import type { PageMeta } from "../types";
import { TrashIcon } from "./icons";

export function TrashPanel() {
  const { loadPages } = useNotes();
  const { open, pos, triggerRef, contentRef, toggle } = usePopover<HTMLButtonElement>();
  const [items, setItems] = useState<PageMeta[]>([]);

  useEffect(() => {
    if (open) {
      api.listDeleted().then(setItems).catch((e) => console.error(e));
    }
  }, [open]);

  const restore = async (id: string) => {
    try {
      await api.restorePage(id);
      setItems(await api.listDeleted());
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
      setItems(await api.listDeleted());
      toast("已彻底删除", "success");
    } catch (e) {
      toast(`删除失败：${e}`, "error");
    }
  };

  return (
    <div className="trash-panel">
      {/* 图标尺寸与竖条其它项对齐（18px）：默认 16px 在 activity-bar 里明显偏小。 */}
      <button ref={triggerRef} className="btn-trash" onClick={toggle} title="回收站">
        <TrashIcon width={18} height={18} />
      </button>
      {open && (
        <div ref={contentRef} className="trash-popover" style={{ top: pos.top, left: pos.left, bottom: pos.bottom }}>
          {items.length === 0 ? (
            <div className="trash-empty">回收站为空</div>
          ) : (
            items.map((p) => (
              <div key={p.id} className="trash-item">
                <span className="trash-icon">{p.kind === "folder" ? "📁" : "📄"}</span>
                <span className="trash-title">{p.title || "未命名"}</span>
                <span className="trash-actions">
                  <button title="恢复" onClick={() => restore(p.id)}>
                    恢复
                  </button>
                  <button title="彻底删除" onClick={() => purge(p.id, p.title)}>
                    删除
                  </button>
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
