import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { tagColor } from "../lib/tagColor";
import { useNotes } from "../store/notes";
import type { AttrDef, PageMeta } from "../types";

interface Group {
  id: string;
  name: string;
  pages: PageMeta[];
}

export function BoardView() {
  const { openPage, loadPages } = useNotes();
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupField, setGroupField] = useState("tag");
  const [attrs, setAttrs] = useState<AttrDef[]>([]);
  const [dragOver, setDragOver] = useState<string | null>(null);

  useEffect(() => {
    api
      .listAttrDefs()
      .then((as) => setAttrs(as.filter((a) => a.attr_type === "select")))
      .catch(() => {});
  }, []);

  const load = () => {
    if (groupField === "tag") {
      api
        .boardData()
        .then((cols) =>
          setGroups(
            cols.map((c) => ({
              id: c.tag?.id ?? "__none",
              name: c.tag?.name ?? "未分类",
              pages: c.pages,
            })),
          ),
        )
        .catch((e) => console.error(e));
    } else {
      const attrId = groupField.slice("attr:".length);
      api
        .boardByAttr(attrId)
        .then(setGroups)
        .catch((e) => console.error(e));
    }
  };
  useEffect(load, [groupField]);

  const onDrop = async (pageId: string, colId: string) => {
    try {
      if (groupField === "tag") {
        if (colId === "__none") return; // tag mode keeps "未分类" as read-only
        await api.moveCard(pageId, colId);
      } else {
        const attrId = groupField.slice("attr:".length);
        if (colId === "__none") {
          await api.removePageProp(pageId, attrId);
        } else {
          await api.setPageProp({ page_id: pageId, attr_id: attrId, value: colId });
        }
      }
      setDragOver(null);
      load();
      await loadPages();
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <div className="board">
      <div className="board-toolbar">
        <label className="board-group-label">分组</label>
        <select
          className="board-group-select"
          value={groupField}
          onChange={(e) => setGroupField(e.target.value)}
        >
          <option value="tag">标签</option>
          {attrs.map((a) => (
            <option key={a.id} value={`attr:${a.id}`}>
              {a.name}
            </option>
          ))}
        </select>
      </div>
      <div className="board-columns">
        {groups.map((col) => (
          <div
            key={col.id}
            className={`board-column ${dragOver === col.id ? "board-column-over" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(col.id);
            }}
            onDragLeave={() => setDragOver((v) => (v === col.id ? null : v))}
            onDrop={(e) => {
              e.preventDefault();
              const pageId = e.dataTransfer.getData("text/plain");
              if (pageId) onDrop(pageId, col.id);
            }}
          >
            <div className="board-column-header">
              <span className="board-col-dot" style={{ background: tagColor(col.name).solid }} />
              <span className="board-column-title">{col.name}</span>
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
    </div>
  );
}
