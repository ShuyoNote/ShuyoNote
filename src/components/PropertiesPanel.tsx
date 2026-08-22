import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { toast } from "../store/toast";
import type { AttrDef, PageProp } from "../types";
import { TagRow, TagAddButton } from "./TagBar";

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

export function PropertiesPanel({ pageId }: { pageId: string }) {
  const [props, setProps] = useState<PageProp[]>([]);
  const [attrs, setAttrs] = useState<AttrDef[]>([]);
  const [open, setOpen] = useState(true);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<string>("text");
  const [newOptions, setNewOptions] = useState("");

  const load = () => {
    api.getPageProps(pageId).then(setProps).catch((e) => console.error(e));
    api.listAttrDefs().then(setAttrs).catch((e) => console.error(e));
  };
  useEffect(load, [pageId]);

  const saveTimers = useRef<Record<string, number>>({});
  const saveValues = useRef<Record<string, string>>({});

  // Debounced per-attribute save: only the last edited value is written, so a
  // burst of keystrokes doesn't fire concurrent, out-of-order IPC writes (which
  // could leave a stale value in the DB).
  const persist = (attrId: string, value: string) => {
    setProps((ps) => ps.map((p) => (p.attr_id === attrId ? { ...p, value } : p)));
    saveValues.current[attrId] = value;
    if (saveTimers.current[attrId]) window.clearTimeout(saveTimers.current[attrId]);
    saveTimers.current[attrId] = window.setTimeout(() => {
      const v = saveValues.current[attrId];
      delete saveValues.current[attrId];
      delete saveTimers.current[attrId];
      api
        .setPageProp({ page_id: pageId, attr_id: attrId, value: v })
        .catch((e) => toast(`保存属性失败：${e}`, "error"));
    }, 450);
  };

  // Flush a pending save immediately (on blur / unmount) so nothing is lost.
  const flush = (attrId: string, value: string) => {
    if (saveTimers.current[attrId]) {
      window.clearTimeout(saveTimers.current[attrId]);
      delete saveTimers.current[attrId];
    }
    delete saveValues.current[attrId];
    api
      .setPageProp({ page_id: pageId, attr_id: attrId, value })
      .catch((e) => toast(`保存属性失败：${e}`, "error"));
  };

  // Flush pending property saves when the panel unmounts (page switch).
  useEffect(() => {
    return () => {
      for (const id of Object.keys(saveValues.current)) {
        api
          .setPageProp({ page_id: pageId, attr_id: id, value: saveValues.current[id] })
          .catch(() => {});
      }
    };
  }, [pageId]);

  const remove = async (attrId: string) => {
    setProps((ps) => ps.filter((p) => p.attr_id !== attrId));
    try {
      await api.removePageProp(pageId, attrId);
    } catch (e) {
      toast(`移除属性失败：${e}`, "error");
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

  return (
    <div className="properties">
      <button className="properties-toggle" onClick={() => setOpen((v) => !v)}>
        <span className="properties-toggle-title">
          属性{props.length > 0 ? `（${props.length}）` : ""}
        </span>
        <span className="properties-toggle-caret">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="properties-body">
          <TagRow pageId={pageId} />
          {props.map((p) => (
            <div key={p.attr_id} className="prop-row">
              <span className="prop-name" title={TYPE_LABELS[p.attr_type] ?? p.attr_type}>
                {p.name}
              </span>
              <ValueEditor
                prop={p}
                onChange={(v) => persist(p.attr_id, v)}
                onCommit={(v) => flush(p.attr_id, v)}
              />
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
          <div className="property-actions">
            <TagAddButton pageId={pageId} />
            <button className="property-add-btn" onClick={() => setAdding(true)}>
              ＋ 添加属性
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ValueEditor({
  prop,
  onChange,
  onCommit,
}: {
  prop: PageProp;
  onChange: (v: string) => void;
  onCommit?: (v: string) => void;
}) {
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
      <select
        className="prop-value"
        value={prop.value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={(e) => onCommit?.(e.target.value)}
      >
        <option value="">—</option>
        {prop.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      className="prop-value"
      value={prop.value}
      placeholder="输入值"
      onChange={(e) => onChange(e.target.value)}
      onBlur={(e) => onCommit?.(e.target.value)}
    />
  );
}
