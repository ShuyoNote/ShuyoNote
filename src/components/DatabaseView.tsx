import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { tagColor } from "../lib/tagColor";
import { useNotes } from "../store/notes";
import { toast } from "../store/toast";
import type { AttrDef, DatabaseQuery } from "../types";

const TYPES = ["text", "number", "date", "checkbox", "select", "multi", "tag"] as const;
const TYPE_LABELS: Record<string, string> = {
  text: "文本",
  number: "数字",
  date: "日期",
  checkbox: "布尔",
  select: "单选",
  multi: "多选",
  tag: "标签",
};

export function DatabaseView({ pageId, title }: { pageId: string; title: string }) {
  const { openPage } = useNotes();
  const [query, setQuery] = useState<DatabaseQuery | null>(null);
  const [attrs, setAttrs] = useState<AttrDef[]>([]);
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const [addingCol, setAddingCol] = useState(false);
  const [viewType, setViewType] = useState<"table" | "gallery">("table");
  const [editingOptionsCol, setEditingOptionsCol] = useState<string | null>(null);
  const [optionsText, setOptionsText] = useState("");

  const load = () => {
    api.queryDatabase(pageId).then(setQuery).catch((e) => toast(String(e), "error"));
    api.listAttrDefs().then(setAttrs).catch(() => {});
  };
  useEffect(load, [pageId]);

  const setCell = async (rowPageId: string, attrId: string, value: string) => {
    setQuery(
      (q) =>
        q && {
          ...q,
          rows: q.rows.map((r) =>
            r.page_id === rowPageId ? { ...r, values: { ...r.values, [attrId]: value } } : r,
          ),
        },
    );
    try {
      await api.setPageProp({ page_id: rowPageId, attr_id: attrId, value });
    } catch (e) {
      toast(`保存失败：${e}`, "error");
    }
  };

  const addColumn = async (attrId: string) => {
    try {
      const columns = await api.addDbColumn(pageId, attrId);
      setQuery((q) => q && { ...q, columns });
    } catch (e) {
      toast(`添加列失败：${e}`, "error");
    }
  };

  const removeColumn = async (attrId: string) => {
    try {
      const columns = await api.removeDbColumn(pageId, attrId);
      setQuery((q) => q && { ...q, columns });
    } catch (e) {
      toast(`移除列失败：${e}`, "error");
    }
  };

  const createAndAddColumn = async (name: string, type: string, options: string[]) => {
    try {
      const attr = await api.createAttr({ name, attr_type: type, options });
      setAttrs((as) => [...as, attr]);
      await addColumn(attr.id);
    } catch (e) {
      toast(`新建列失败：${e}`, "error");
    }
  };

  const openOptionsEditor = (c: AttrDef) => {
    setEditingOptionsCol(c.id);
    setOptionsText(c.options.join(", "));
  };

  const saveOptions = async (attrId: string) => {
    const options = optionsText.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    try {
      const updated = await api.updateAttr({ id: attrId, options });
      setQuery((q) => q && { ...q, columns: q.columns.map((c) => (c.id === attrId ? updated : c)) });
      setAttrs((as) => as.map((a) => (a.id === attrId ? updated : a)));
      setEditingOptionsCol(null);
    } catch (e) {
      toast(`更新选项失败：${e}`, "error");
    }
  };

  const rows = useMemo(() => {
    if (!query) return [];
    let rs = query.rows;
    if (filter.trim()) {
      const f = filter.trim().toLowerCase();
      rs = rs.filter((r) => r.title.toLowerCase().includes(f));
    }
    if (sort) {
      const { key, dir } = sort;
      rs = [...rs].sort((a, b) => {
        if (key === "__title") {
          return (a.title || "").localeCompare(b.title || "", "zh") * dir;
        }
        const col = query.columns.find((c) => c.id === key);
        const av = a.values[key] ?? "";
        const bv = b.values[key] ?? "";
        if (col?.attr_type === "number") {
          return ((parseFloat(av) || 0) - (parseFloat(bv) || 0)) * dir;
        }
        return av.localeCompare(bv, "zh") * dir;
      });
    }
    return rs;
  }, [query, filter, sort]);

  const toggleSort = (key: string) => {
    setSort((s) => (s && s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 }));
  };

  const availableAttrs = useMemo(() => {
    if (!query) return attrs;
    const used = new Set(query.columns.map((c) => c.id));
    return attrs.filter((a) => !used.has(a.id));
  }, [attrs, query]);

  if (!query) {
    return <div className="database-view database-empty">加载中…</div>;
  }

  return (
    <div className="database-view">
      <div className="database-head">
        <h1 className="database-title">{title || "数据库"}</h1>
        <input
          className="database-filter"
          placeholder="筛选页面…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <div className="db-view-switch">
          <button
            className={viewType === "table" ? "db-view-active" : ""}
            onClick={() => setViewType("table")}
          >
            ☰ 表格
          </button>
          <button
            className={viewType === "gallery" ? "db-view-active" : ""}
            onClick={() => setViewType("gallery")}
          >
            ▦ 画廊
          </button>
        </div>
        <span className="database-count">{rows.length} 条</span>
      </div>

      {viewType === "table" ? (
        <div className="database-table-wrap">
          <table className="database-table">
            <thead>
              <tr>
                <th className="db-th" onClick={() => toggleSort("__title")}>
                  页面{sort?.key === "__title" ? (sort.dir === 1 ? " ↑" : " ↓") : ""}
                </th>
                {query.columns.map((c) => (
                  <th
                    key={c.id}
                    className="db-th"
                    title={TYPE_LABELS[c.attr_type] ?? c.attr_type}
                    onClick={() => toggleSort(c.id)}
                  >
                    <span className="db-th-name">
                      {c.name}
                      {sort?.key === c.id ? (sort.dir === 1 ? " ↑" : " ↓") : ""}
                    </span>
                    {(c.attr_type === "select" || c.attr_type === "multi") && (
                      <button
                        className="db-col-options"
                        title="编辑选项"
                        onClick={(e) => {
                          e.stopPropagation();
                          openOptionsEditor(c);
                        }}
                      >
                        ⚙
                      </button>
                    )}
                    <button
                      className="db-col-remove"
                      title="移除列"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeColumn(c.id);
                      }}
                    >
                      ×
                    </button>
                  </th>
                ))}
                <th className="db-th db-th-add">
                  <button className="db-add-col" onClick={() => setAddingCol((v) => !v)}>
                    ＋ 列
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.page_id}>
                  <td className="db-cell db-cell-title">
                    <button className="db-title" onClick={() => openPage(r.page_id)}>
                      {r.title || "未命名"}
                    </button>
                  </td>
                  {query.columns.map((c) => (
                    <td key={c.id} className="db-cell">
                      <DbCellEditor
                        attr={c}
                        value={r.values[c.id] ?? ""}
                        onChange={(v) => setCell(r.page_id, c.id, v)}
                      />
                    </td>
                  ))}
                  <td className="db-cell db-cell-empty" />
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td className="db-empty" colSpan={query.columns.length + 2}>
                    {query.columns.length === 0 ? "点击「＋ 列」添加属性列" : "无匹配页面"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="db-gallery">
          {rows.map((r) => {
            const firstSelect = query.columns
              .filter((c) => c.attr_type === "select" && (r.values[c.id] ?? "") !== "")
              .map((c) => ({ value: r.values[c.id] }))[0];
            return (
              <div key={r.page_id} className="db-gallery-card" onClick={() => openPage(r.page_id)}>
                <div className="db-gallery-title">{r.title || "未命名"}</div>
                {firstSelect && (
                  <span
                    className="db-gallery-badge"
                    style={{
                      background: tagColor(firstSelect.value).soft,
                      color: tagColor(firstSelect.value).solid,
                    }}
                  >
                    {firstSelect.value}
                  </span>
                )}
              </div>
            );
          })}
          {rows.length === 0 && <div className="db-empty">无匹配页面</div>}
        </div>
      )}

      {addingCol && (
        <div className="db-add-col-panel">
          <div className="db-add-col-title">添加列</div>
          {availableAttrs.map((a) => (
            <button
              key={a.id}
              className="db-add-col-item"
              onClick={() => {
                addColumn(a.id);
                setAddingCol(false);
              }}
            >
              <span>{a.name}</span>
              <span className="db-add-col-type">{TYPE_LABELS[a.attr_type] ?? a.attr_type}</span>
            </button>
          ))}
          {availableAttrs.length === 0 && <div className="db-add-col-empty">暂无可用属性</div>}
          <DbNewAttr
            onCreate={(name, type, options) => {
              createAndAddColumn(name, type, options);
              setAddingCol(false);
            }}
          />
        </div>
      )}

      {editingOptionsCol && (
        <div className="db-add-col-panel">
          <div className="db-add-col-title">编辑选项（逗号分隔）</div>
          <input
            className="db-input db-options-input"
            value={optionsText}
            onChange={(e) => setOptionsText(e.target.value)}
            placeholder="选项，逗号分隔"
          />
          <div className="db-options-actions">
            <button className="db-new-attr-btn" onClick={() => saveOptions(editingOptionsCol)}>
              保存
            </button>
            <button className="db-options-cancel" onClick={() => setEditingOptionsCol(null)}>
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function DbCellEditor({
  attr,
  value,
  onChange,
}: {
  attr: AttrDef;
  value: string;
  onChange: (v: string) => void;
}) {
  if (attr.attr_type === "checkbox") {
    return (
      <input
        type="checkbox"
        className="db-checkbox"
        checked={value === "true"}
        onChange={(e) => onChange(e.target.checked ? "true" : "false")}
      />
    );
  }
  if (attr.attr_type === "select") {
    return (
      <select className="db-input" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        {attr.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      className="db-input"
      value={value}
      placeholder="—"
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function DbNewAttr({
  onCreate,
}: {
  onCreate: (name: string, type: string, options: string[]) => void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<string>("text");
  const [options, setOptions] = useState("");
  const needsOptions = type === "select" || type === "multi";

  const commit = () => {
    if (!name.trim()) return;
    const opts = needsOptions
      ? options.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
      : [];
    onCreate(name.trim(), type, opts);
  };

  return (
    <div className="db-new-attr">
      <input
        className="db-input"
        placeholder="新属性名"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && commit()}
      />
      <select className="db-input" value={type} onChange={(e) => setType(e.target.value)}>
        {TYPES.map((t) => (
          <option key={t} value={t}>
            {TYPE_LABELS[t]}
          </option>
        ))}
      </select>
      {needsOptions && (
        <input
          className="db-input"
          placeholder="选项，逗号分隔"
          value={options}
          onChange={(e) => setOptions(e.target.value)}
        />
      )}
      <button className="db-new-attr-btn" onClick={commit}>
        新建
      </button>
    </div>
  );
}
