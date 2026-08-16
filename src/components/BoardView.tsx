import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { tagColor } from "../lib/tagColor";
import { useNotes } from "../store/notes";
import type { BoardColumn } from "../types";

export function BoardView() {
  const { openPage, loadPages } = useNotes();
  const [columns, setColumns] = useState<BoardColumn[]>([]);
  const [dragOver, setDragOver] = useState<string | null>(null);

  const load = () => {
    api.boardData().then(setColumns).catch((e) => console.error(e));
  };

  useEffect(() => {
    load();
  }, []);

  const onDrop = async (pageId: string, tagId: string) => {
    try {
      await api.moveCard(pageId, tagId);
      setDragOver(null);
      load();
      await loadPages();
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <div className="board">
      {columns.map((col) => (
        <div
          key={col.tag?.id ?? "__untagged"}
          className={`board-column ${dragOver === (col.tag?.id ?? "__untagged") ? "board-column-over" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(col.tag?.id ?? "__untagged");
          }}
          onDragLeave={() => setDragOver((v) => (v === (col.tag?.id ?? "__untagged") ? null : v))}
          onDrop={(e) => {
            e.preventDefault();
            const pageId = e.dataTransfer.getData("text/plain");
            if (pageId && col.tag) onDrop(pageId, col.tag.id);
          }}
        >
          <div className="board-column-header">
            <span className="board-col-dot" style={{ background: tagColor(col.tag?.name ?? "未分类").solid }} />
            <span className="board-column-title">{col.tag?.name ?? "未分类"}</span>
            <span className="board-column-count">{col.pages.length}</span>
          </div>
          <div className="board-column-body">
            {col.pages.map((p) => (
              <div
                key={p.id}
                className="board-card"
                draggable
                onDragStart={(e) => e.dataTransfer.setData("text/plain", p.id)}
                onClick={() => openPage(p.id)}
              >
                <span className="board-card-title">{p.title || "未命名"}</span>
              </div>
            ))}
            {col.pages.length === 0 && <div className="board-empty">拖拽卡片到这里</div>}
          </div>
        </div>
      ))}
    </div>
  );
}
