import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { tagColor } from "../lib/tagColor";
import { useNotes } from "../store/notes";
import type { AttrDef, PageMeta } from "../types";

interface Group {
  id: string;
  name: string;
  pages: PageMeta[];
  color?: string | null;
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
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const dragMovedRef = useRef(false);
  const dragCardTitleRef = useRef("");
  // 列(组)拖拽换序：列头拖动调整整列顺序。
  const [colDrag, setColDrag] = useState<string | null>(null);
  const colDragStartRef = useRef<{ x: number; y: number } | null>(null);
  const colDragMovedRef = useRef(false);
  const [colDragOver, setColDragOver] = useState<string | null>(null);

  // 列拖拽：列头按下候选，全局 move 找落点列，up 落列则 reorder_tag。
  useEffect(() => {
    if (!colDrag) return;
    const onMove = (e: PointerEvent) => {
      if (!colDragStartRef.current) return;
      if (!colDragMovedRef.current && Math.hypot(e.clientX - colDragStartRef.current.x, e.clientY - colDragStartRef.current.y) < 5) return;
      colDragMovedRef.current = true;
      e.preventDefault();
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const col = el?.closest?.("[data-col]") as HTMLElement | null;
      setColDragOver(col?.dataset.col ?? null);
    };
    const onUp = (e: PointerEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const col = el?.closest?.("[data-col]") as HTMLElement | null;
      const target = col?.dataset.col ?? null;
      const moved = colDragMovedRef.current;
      setColDrag(null);
      setColDragOver(null);
      colDragStartRef.current = null;
      colDragMovedRef.current = false;
      if (target && moved && target !== colDrag) void onReorderCol(colDrag, target);
    };
    const onCancel = () => {
      setColDrag(null);
      setColDragOver(null);
      colDragStartRef.current = null;
      colDragMovedRef.current = false;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
  }, [colDrag]);

  useEffect(() => {
    if (!dragPage) return;
    const onMove = (e: PointerEvent) => {
      if (!dragStartRef.current) return;
      if (!dragMovedRef.current && Math.hypot(e.clientX - dragStartRef.current.x, e.clientY - dragStartRef.current.y) < 5) return;
      if (!dragMovedRef.current) {
        dragMovedRef.current = true;
        const card = document.getElementById(`board-card-${dragPage}`);
        dragCardTitleRef.current = card?.textContent?.trim() ?? "";
      }
      e.preventDefault();
      // 浮动卡片跟随鼠标（微偏移避免遮住指针）。
      setDragPos({ x: e.clientX, y: e.clientY });
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const col = el?.closest?.("[data-col]") as HTMLElement | null;
      setDragOver(col?.dataset.col ?? null);
    };
    const onUp = (e: PointerEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const col = el?.closest?.("[data-col]") as HTMLElement | null;
      const card = el?.closest?.("[data-page]") as HTMLElement | null;
      const target = col?.dataset.col ?? null;
      const before = card?.dataset.page ?? null; // 落点卡片（拖到它前面）
      const moved = dragMovedRef.current;
      setDragOver(null);
      setDragPage(null);
      setDragPos(null);
      dragStartRef.current = null;
      dragMovedRef.current = false;
      if (target && moved) void onDrop(dragPage, target, before);
    };
    const onCancel = () => {
      setDragOver(null);
      setDragPage(null);
      setDragPos(null);
      dragStartRef.current = null;
      dragMovedRef.current = false;
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
              color: c.tag?.color ?? null,
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

  const onDrop = async (pageId: string, colId: string, beforePageId?: string | null) => {
    try {
      if (groupField === "tag") {
        if (colId === "__none") return; // tag mode keeps "未分类" as read-only
        // 同列/跨列换序：指定落点卡片 → reorder_card；否则 move_card（列尾）。
        await api.reorderCard(pageId, colId, beforePageId || null);
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

  const onReorderCol = async (tagId: string, beforeTagId: string) => {
    try {
      await api.reorderTag(tagId, beforeTagId);
      load();
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
            className={`board-column ${(dragOver === col.id || colDragOver === col.id) ? "board-column-over" : ""} ${colDrag === col.id ? "board-column-dragging" : ""}`}
          >
            <div
              className="board-column-header"
              title="拖动列头调整列顺序"
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                colDragStartRef.current = { x: e.clientX, y: e.clientY };
                colDragMovedRef.current = false;
                setColDrag(col.id);
              }}
            >
              <span className="board-col-dot" style={{ background: col.color ?? tagColor(col.name).solid }} />
              <span className="board-column-title">{col.name}</span>
              <span className="board-column-count">{col.pages.length}</span>
            </div>
            <div className="board-column-body">
              {col.pages.map((p) => (
                <div
                  key={p.id}
                  id={`board-card-${p.id}`}
                  data-page={p.id}
                  className={`board-card${dragPage === p.id ? " board-card-dragging" : ""}`}
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    dragStartRef.current = { x: e.clientX, y: e.clientY };
                    dragMovedRef.current = false;
                    setDragPage(p.id);
                  }}
                  onClick={() => {
                    // 拖拽后的释放不当作"打开"(is via dragMovedRef)；纯点击才打开。
                    if (dragMovedRef.current) return;
                    openPage(p.id);
                  }}
                >
                  <span className="board-card-title">{p.title || "未命名"}</span>
                </div>
              ))}
              {col.pages.length === 0 && <div className="board-empty">拖拽卡片到这里</div>}
            </div>
          </div>
        ))}
      </div>
      {/* 拖拽中的浮动卡片：跟随指针，给用户明确"拖动的是谁"。 */}
      {dragPage && dragPos && (
        <div className="board-card board-card-ghost" style={{ left: dragPos.x + 8, top: dragPos.y + 8, pointerEvents: "none" }}>
          {dragCardTitleRef.current || "…"}
        </div>
      )}
    </div>
  );
}
