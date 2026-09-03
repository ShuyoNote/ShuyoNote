import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { toast } from "../store/toast";
import { usePropertyUiStore } from "../store/propertyUi";
import type { AttrDef, PageProp } from "../types";
import { TagRow } from "./TagBar";

const TYPES = ["text", "number", "date", "checkbox", "select", "multi"] as const;
const TYPE_LABELS: Record<string, string> = {
  text: "文本",
  number: "数字",
  date: "日期",
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

  const load = () => {
    api
      .getPageProps(pageId)
      .then((ps) => {
        setProps(ps);
      })
      .catch((e) => console.error(e));
    api.listAttrDefs().then(setAttrs).catch((e) => console.error(e));
    api.pageTags(pageId).then(setPageTags).catch((e) => console.error(e));
  };
  useEffect(load, [pageId]);

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
          {nonTagProps.map((p) => (
              <div key={p.attr_id} className="prop-row">
                <span className="prop-name" title={TYPE_LABELS[p.attr_type] ?? p.attr_type}>
                  {p.name}
                </span>
                <ValueEditor prop={p} onChange={(v) => persist(p.attr_id, v)} />
                <button className="prop-remove" onClick={() => remove(p.attr_id)} title="移除属性">
                  ×
                </button>
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
