import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useNotes } from "../store/notes";
import type { PageMeta } from "../types";

export function TrashPanel() {
  const { loadPages } = useNotes();
  const [open, setOpen] = useState(false);
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
    } catch (e) {
      console.error(e);
    }
  };

  const purge = async (id: string, title: string) => {
    if (!confirm(`彻底删除「${title || "未命名"}」？此操作不可恢复。`)) return;
    try {
      await api.purgePage(id);
      setItems(await api.listDeleted());
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <div className="trash-panel">
      <button className="btn-trash" onClick={() => setOpen((v) => !v)} title="回收站">
        回收站
      </button>
      {open && (
        <div className="trash-popover">
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
