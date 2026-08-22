import { useEffect, useState } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { usePopover } from "../hooks/usePopover";
import { api } from "../lib/api";
import { toast } from "../store/toast";
import { useTagManagerStore } from "../store/tagManager";
import { tagColor } from "../lib/tagColor";
import type { Tag } from "../types";

// Global tag manager: see all tags + usage, create, rename (merges), delete.
export function TagManager() {
  const [tags, setTags] = useState<Tag[]>([]);
  const [newName, setNewName] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editVal, setEditVal] = useState("");
  const { open, pos, triggerRef, contentRef, toggle, close } = usePopover<HTMLButtonElement>();

  const load = () => api.listTags().then(setTags).catch(() => {});
  useEffect(() => {
    load();
  }, []);

  const create = async () => {
    const n = newName.trim();
    if (!n) return;
    try {
      await api.createTag(n);
      setNewName("");
      useTagManagerStore.getState().bump();
      load();
      toast(`已创建标签「${n}」`, "success");
    } catch (e) {
      toast(`创建失败：${e}`, "error");
    }
  };

  const startEdit = (t: Tag) => {
    setEditing(t.id);
    setEditVal(t.name);
  };

  const commitEdit = async () => {
    if (!editing) return;
    const v = editVal.trim();
    const prev = tags.find((t) => t.id === editing);
    setEditing(null);
    if (v && v !== prev?.name) {
      try {
        await api.renameTag(editing, v);
        useTagManagerStore.getState().bump();
        load();
        toast("已重命名标签", "success");
      } catch (e) {
        toast(`重命名失败：${e}`, "error");
      }
    }
  };

  const remove = async (t: Tag) => {
    const ok = await confirm(`删除标签「${t.name}」？将从 ${t.page_count ?? 0} 个页面中移除。`);
    if (!ok) return;
    try {
      await api.deleteTag(t.id);
      useTagManagerStore.getState().bump();
      load();
      toast("已删除标签", "success");
    } catch (e) {
      toast(`删除失败：${e}`, "error");
    }
  };

  return (
    <>
      <button ref={triggerRef} className="sidebar-tags-manage" onClick={toggle} title="标签管理">
        🏷 标签管理
      </button>
      {open && (
        <div ref={contentRef} className="tag-manager" style={{ position: "fixed", top: pos.top, left: pos.left }}>
          <div className="tag-manager-head">
            <span className="tag-manager-title">标签管理</span>
            <button className="db-panel-close" onClick={close} title="关闭">
              ×
            </button>
          </div>
          <div className="tag-manager-create">
            <input
              className="tag-input"
              placeholder="新标签名"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  create();
                }
              }}
            />
            <button className="tag-manager-add" onClick={create} title="创建标签">
              ＋
            </button>
          </div>
          <div className="tag-manager-list">
            {tags.map((t) => (
              <div key={t.id} className="tag-manager-row">
                <span className="tag-dot" style={{ background: tagColor(t.name).solid }} />
                {editing === t.id ? (
                  <input
                    className="tag-manager-edit"
                    autoFocus
                    value={editVal}
                    onChange={(e) => setEditVal(e.target.value)}
                    onBlur={commitEdit}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commitEdit();
                      } else if (e.key === "Escape") {
                        setEditing(null);
                      }
                    }}
                  />
                ) : (
                  <span className="tag-manager-name" title={t.name}>
                    {t.name}
                  </span>
                )}
                <span className="tag-manager-count">{t.page_count ?? 0} 页</span>
                <span className="tag-manager-actions">
                  {editing !== t.id && (
                    <button title="重命名" onClick={() => startEdit(t)}>
                      ✎
                    </button>
                  )}
                  <button title="删除标签" onClick={() => remove(t)}>
                    ×
                  </button>
                </span>
              </div>
            ))}
            {tags.length === 0 && <div className="tag-manager-empty">暂无标签，输入名称创建</div>}
          </div>
        </div>
      )}
    </>
  );
}
