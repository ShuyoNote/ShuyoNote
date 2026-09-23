import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { toast } from "../store/toast";
import { usePropertyUiStore } from "../store/propertyUi";
import type { AttrDef, PageProp } from "../types";
import { TagRow } from "./TagBar";
// 「时间」属性的编辑器单独一个文件（**一行只有一个可见输入框**，见那边的头注）：
// 它原来长在这里、且一行并排两个框 —— owner 2026-09-21 的截图问的就是那个。
import { DatetimeValueEditor } from "./DatetimeValueEditor";

// 「时间」= 日期 + 时刻（attr_type = "datetime"），与只到日的"日期"并列。
const TYPES = ["text", "number", "date", "datetime", "checkbox", "select", "multi"] as const;
// 临时停用：页面属性区的手工拖拽移动（拖拖换序）。改为 true 即可恢复。
const DRAG_MOVE_ENABLED = false;
const TYPE_LABELS: Record<string, string> = {
  text: "文本",
  number: "数字",
  date: "日期",
  datetime: "时间",
  checkbox: "布尔",
  select: "单选",
  multi: "多选",
};

export function PropertiesPanel({ pageId }: { pageId: string }) {
  const [props, setProps] = useState<PageProp[]>([]);
  const [attrs, setAttrs] = useState<AttrDef[]>([]);
  const [pageTags, setPageTags] = useState<{ id: string; name: string }[]>([]);
  const [open, setOpen] = useState(true);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<string>("text");
  const [newOptions, setNewOptions] = useState("");

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [tick, setTick] = useState(0);

  const load = () => {
    setLoading(true);
    setError(false);
    Promise.all([api.getPageProps(pageId), api.listAttrDefs(), api.pageTags(pageId)])
      .then(([ps, as, tags]) => {
        setProps(ps);
        setAttrs(as);
        setPageTags(tags);
        setLoading(false);
      })
      .catch((e) => {
        console.error(e);
        setError(true);
        setLoading(false);
      });
  };
  // ⚠️ `propsRev` 必须在依赖里：它表示"**别处**替这一页写了属性"（社区帖存成笔记那条路——
  //    先建页、后写属性 ⇒ 本面板挂载时拉到的是"没属性"的那一份）。少了它就得重新打开这一页
  //    才看得到属性（2026-09-23 用户实测）。它必须**声明在 effect 之前**（依赖数组在渲染时求值，
  //    写在后面会 TDZ 抛 "Cannot access before initialization"）。
  const propsRev = usePropertyUiStore((s) => s.propsRev);
  useEffect(load, [pageId, tick, propsRev]);

  // "添加属性" from the page-actions row: open the panel and focus the add input.
  const addPropSeq = usePropertyUiStore((s) => s.addPropSeq);
  const tagVisible = usePropertyUiStore((s) => s.tagVisible);
  useEffect(() => {
    if (addPropSeq > 0) {
      setOpen(true);
      setAdding(true);
    }
  }, [addPropSeq]);

  // The metadata card only shows when the page actually has properties (tag rows
  // or non-tag property rows); otherwise the title connects straight to content.
  const nonTagProps = props.filter((p) => p.attr_type !== "tag");
  const hasProps = nonTagProps.length > 0 || pageTags.length > 0; // card shown iff metadata present

  // 属性区按 attr_defs.sort_order 顺序显示（listAttrDefs 已按该顺序返回）。
  const orderedProps = useMemo(() => {
    const order = new Map(attrs.map((a, i) => [a.id, i]));
    return [...nonTagProps].sort(
      (x, y) => (order.get(x.attr_id) ?? 9999) - (order.get(y.attr_id) ?? 9999),
    );
  }, [nonTagProps, attrs]);

  const setOrder = (next: AttrDef[]) => {
    setAttrs(next);
    void api.reorderAttrs(next.map((a) => a.id)).catch((e) => toast(`保存属性顺序失败：${e}`, "error"));
  };
  const moveProp = (attrId: string, dir: -1 | 1) => {
    const idx = attrs.findIndex((a) => a.id === attrId);
    const j = idx + dir;
    if (idx < 0 || j < 0 || j >= attrs.length) return;
    const next = [...attrs];
    [next[idx], next[j]] = [next[j], next[idx]];
    setOrder(next);
  };
  // HTML5 拖拽换序：从 fromIdx 拖到 toIdx。
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  // 拖拽时鼠标所在的插入位置（用于显示位置指示线；null=不显示）。
  const [overIdx, setOverIdx] = useState<number | null>(null);
  /**
   * 窄屏的**行动作面板**（`⋯`）对着哪一条属性打开。
   *
   * 存 `attr_id` 而**不是下标**：面板开着的时候用户可能刚点过「上移」，`orderedProps`
   * 的顺序当场就变了——存下标会指到另一条属性上去（"点了上移，面板里变成别人的名字"）。
   * 桌面不用它（那三个按钮直接排在行尾）。
   */
  const [moreId, setMoreId] = useState<string | null>(null);
  const onDropTo = (toIdx: number) => {
    if (dragIdx === null || dragIdx === toIdx) { setDragIdx(null); setOverIdx(null); return; }
    const next = [...attrs];
    const [moved] = next.splice(dragIdx, 1);
    next.splice(toIdx, 0, moved);
    setOrder(next);
    setDragIdx(null);
    setOverIdx(null);
  };

  // Serialize writes per attribute so a later value is never overwritten by an
  // earlier, out-of-order set_page_prop call. Each edit is saved immediately.
  const writeQueue = useRef<Record<string, Promise<unknown>>>({});

  const persist = (attrId: string, value: string) => {
    console.log("[ShuyoNote] prop persist", { pageId, attrId, value });
    setProps((ps) => ps.map((p) => (p.attr_id === attrId ? { ...p, value } : p)));
    const next = (writeQueue.current[attrId] ?? Promise.resolve()).then(() =>
      api
        .setPageProp({ page_id: pageId, attr_id: attrId, value })
        .then((r) => console.log("[ShuyoNote] prop saved", { pageId, attrId, value, r })),
    );
    writeQueue.current[attrId] = next.catch((e) => toast(`保存属性失败：${e}`, "error"));
  };

  const remove = async (attrId: string) => {
    console.log("[ShuyoNote] prop remove start", { pageId, attrId });
    setProps((ps) => ps.filter((p) => p.attr_id !== attrId));
    try {
      await api.removePageProp(pageId, attrId);
      console.log("[ShuyoNote] prop removed", { pageId, attrId });
      // Re-sync from the DB so the panel always reflects what really persisted.
      load();
      toast("已移除属性", "success");
    } catch (e) {
      toast(`移除属性失败：${e}`, "error");
      console.error("[ShuyoNote] prop remove FAILED", { pageId, attrId, e });
    }
  };

  const addProp = async () => {
    const name = newName.trim();
    if (!name) return;
    try {
      let attr = attrs.find((a) => a.name.toLowerCase() === name.toLowerCase());
      if (!attr) {
        const options =
          newType === "select" || newType === "multi"
            ? newOptions.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
            : [];
        attr = await api.createAttr({ name, attr_type: newType, options });
        setAttrs((as) => [...as, attr!]);
      }
      const initial =
        attr.attr_type === "checkbox"
          ? "false"
          : attr.attr_type === "select" && attr.options.length > 0
            ? attr.options[0]
            : "";
      await api.setPageProp({ page_id: pageId, attr_id: attr.id, value: initial });
      setNewName("");
      setNewOptions("");
      setAdding(false);
      load();
    } catch (e) {
      toast(`添加属性失败：${e}`, "error");
    }
  };

  if (error) {
    return (
      <div className="metadata-card">
        <div className="properties">
          <div className="properties-load-error">
            加载失败
            <button className="properties-retry" onClick={() => setTick((t) => t + 1)}>重试</button>
          </div>
        </div>
      </div>
    );
  }
  if (loading) {
    return (
      <div className="metadata-card">
        <div className="properties">
          <div className="properties-loading">加载中…</div>
        </div>
      </div>
    );
  }

  // Hide the whole properties panel when the page has no properties/tags (the
  // page-actions row is the entry to add). Show while adding a property/tag.
  if (!hasProps && !adding && !tagVisible) return null;

  return (
    <div className={hasProps ? "metadata-card" : ""}>
      <div className="properties">
      <button className="properties-toggle" onClick={() => setOpen((v) => !v)}>
        <span className="properties-toggle-title">
          属性{nonTagProps.length > 0 ? `（${nonTagProps.length}）` : ""}
        </span>
        <span className="properties-toggle-caret">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="properties-body">
          <TagRow pageId={pageId} />
          {orderedProps.map((p, i) => (
              <div
                key={p.attr_id}
                className={`prop-row${dragIdx === i ? " is-dragging" : ""}${overIdx === i ? " drop-before" : ""}${overIdx === i + 1 ? " drop-after" : ""}`}
                {...(DRAG_MOVE_ENABLED
                  ? {
                      onDragOver: (e: React.DragEvent) => {
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                        const rect = e.currentTarget.getBoundingClientRect();
                        setOverIdx(e.clientY < rect.top + rect.height / 2 ? i : i + 1);
                      },
                      onDragLeave: () => setOverIdx(null),
                      onDrop: () => onDropTo(overIdx ?? i),
                    }
                  : {})}
              >
                {DRAG_MOVE_ENABLED && (
                  <button
                    className="prop-grip"
                    title="拖动调整属性顺序"
                    draggable
                    onDragStart={(e: React.DragEvent) => { setDragIdx(i); e.dataTransfer.effectAllowed = "move"; }}
                    onDragEnd={() => setDragIdx(null)}
                  >⠿</button>
                )}
                <span className="prop-name" title={TYPE_LABELS[p.attr_type] ?? p.attr_type}>
                  {p.name}
                </span>
                <ValueEditor prop={p} onChange={(v) => persist(p.attr_id, v)} />
                <span className="prop-order-btns">
                  {/* 窄屏只留这一个 `⋯`（44×44）：三个按钮各自补到 44 会白吃掉 60px 的值列宽度，
                      而值列在 320px 上本来就只有一百多像素。桌面它 `display:none`（那三个照旧）。 */}
                  <button
                    className="prop-more"
                    title="更多操作"
                    aria-label="更多操作"
                    onClick={() => setMoreId(p.attr_id)}
                  >
                    ⋯
                  </button>
                  <button className="prop-order" disabled={i === 0} onClick={() => moveProp(p.attr_id, -1)} title="上移">
                    <svg className="prop-ico" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M6 15l6-6 6 6" /></svg>
                  </button>
                  <button className="prop-order" disabled={i === orderedProps.length - 1} onClick={() => moveProp(p.attr_id, 1)} title="下移">
                    <svg className="prop-ico" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
                  </button>
                  <button className="prop-remove" onClick={() => remove(p.attr_id)} title="移除属性">
                    <svg className="prop-ico" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
                  </button>
                </span>
              </div>
            ))}
          {adding ? (
            <div className="prop-add-row">
              <input
                className="prop-add-name"
                placeholder="属性名"
                value={newName}
                autoFocus
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addProp()}
              />
              <select
                className="prop-add-type"
                value={newType}
                onChange={(e) => setNewType(e.target.value)}
              >
                {TYPES.map((t) => (
                  <option key={t} value={t}>
                    {TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
              {(newType === "select" || newType === "multi") && (
                <input
                  className="prop-add-options"
                  placeholder="选项，逗号分隔"
                  value={newOptions}
                  onChange={(e) => setNewOptions(e.target.value)}
                />
              )}
              <button className="prop-add-confirm" onClick={addProp}>
                添加
              </button>
              <button className="prop-add-cancel" onClick={() => setAdding(false)}>
                取消
              </button>
            </div>
          ) : null}
        </div>
      )}
      {/* 窄屏的「行尾 ⋯」动作面板：贴底成面板（`position: fixed` ⇒ 不参与
          `.properties-body` 的网格布局）。桌面这条分支根本不渲染（`.prop-more` 是
          `display:none`，用户点不到它）。 */}
      {moreId !== null &&
        (() => {
          const idx = orderedProps.findIndex((x) => x.attr_id === moreId);
          if (idx < 0) return null; // 这条属性刚被移除/换掉了
          const p = orderedProps[idx];
          const close = () => setMoreId(null);
          const act = (fn: () => void) => () => {
            fn();
            close();
          };
          return (
            <>
              <div className="prop-ctx-backdrop" onClick={close} aria-hidden />
              <div className="prop-ctx is-sheet" role="menu" aria-label={`${p.name} 的属性操作`}>
                <div className="prop-ctx-title" title={p.name}>{p.name}</div>
                <div className="prop-ctx-list">
                  <button className="prop-ctx-item" disabled={idx === 0} onClick={act(() => moveProp(p.attr_id, -1))}>
                    上移
                  </button>
                  <button
                    className="prop-ctx-item"
                    disabled={idx === orderedProps.length - 1}
                    onClick={act(() => moveProp(p.attr_id, 1))}
                  >
                    下移
                  </button>
                  <button className="prop-ctx-item is-danger" onClick={act(() => void remove(p.attr_id))}>
                    移除属性
                  </button>
                </div>
              </div>
            </>
          );
        })()}
      </div>
    </div>
  );
}


function ValueEditor({ prop, onChange }: { prop: PageProp; onChange: (v: string) => void }) {
  if (prop.attr_type === "checkbox") {
    return (
      <input
        type="checkbox"
        className="prop-checkbox"
        checked={prop.value === "true"}
        onChange={(e) => onChange(e.target.checked ? "true" : "false")}
      />
    );
  }
  if (prop.attr_type === "select") {
    return (
      <select className="prop-value" value={prop.value} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        {prop.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }
  if (prop.attr_type === "datetime") {
    // 两条输入路径**并存**：选择器（带秒）＋ 手输（认「2008年5月9日 15:30:00」等写法）。
    // 两条都走 `lib/dateTimeValue` 的同一份解析/格式化，避免两边不一致。
    return <DatetimeValueEditor value={prop.value} onChange={onChange} />;
  }
  if (prop.attr_type === "date") {
    // 日期选择器（不用手输 YYYY-MM-DD）。
    return (
      <input
        type="date"
        className="prop-value"
        value={/^\d{4}-\d{2}-\d{2}/.test(prop.value) ? prop.value.slice(0, 10) : ""}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <input
      className="prop-value"
      value={prop.value}
      placeholder="输入值"
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
