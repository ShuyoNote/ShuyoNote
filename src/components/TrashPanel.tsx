import { useEffect, useState } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { usePopover } from "../hooks/usePopover";
import { api } from "../lib/api";
import { useNotes } from "../store/notes";
import { toast } from "../store/toast";
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
    if (!(await confirm(`彻底删除「${title || "未命名"}」？此操作不可恢复。`))) return;
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
      <button ref={triggerRef} className="btn-trash" onClick={toggle} title="回收站">
        <TrashIcon />
      </button>
      {open && (
        <div ref={contentRef} className="trash-popover" style={{ top: pos.top, left: pos.left }}>
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
