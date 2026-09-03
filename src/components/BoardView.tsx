import { useEffect, useRef, useState } from "react";
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
  // Pointer-based drag override for Tauri WebView (HTML5 drag/drop is suppressed
  // by dragDropEnabled). Mirrors the PageTree pointer-drag approach.
  const [dragPage, setDragPage] = useState<string | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!dragPage) return;
    let moved = false;
    const onMove = (e: PointerEvent) => {
      if (!dragStartRef.current) return;
      if (!moved && Math.hypot(e.clientX - dragStartRef.current.x, e.clientY - dragStartRef.current.y) < 5) return;
      moved = true;
      e.preventDefault();
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const col = el?.closest?.("[data-col]") as HTMLElement | null;
      setDragOver(col?.dataset.col ?? null);
    };
    const onUp = (e: PointerEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const col = el?.closest?.("[data-col]") as HTMLElement | null;
      const target = col?.dataset.col ?? null;
      setDragOver(null);
      setDragPage(null);
      dragStartRef.current = null;
      if (target && moved) void onDrop(dragPage, target);
    };
    const onCancel = () => {
      setDragOver(null);
      setDragPage(null);
      dragStartRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
  }, [dragPage]);

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
            data-col={col.id}
            className={`board-column ${dragOver === col.id ? "board-column-over" : ""}`}
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
                  className={`board-card${dragPage === p.id ? " board-card-dragging" : ""}`}
                  onPointerDown={(e) => {
                    // 左键按下即开始拖拽候选（pointer-based，兼容 Tauri WebView）。
                    if (e.button !== 0) return;
                    dragStartRef.current = { x: e.clientX, y: e.clientY };
                    setDragPage(p.id);
                  }}
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
