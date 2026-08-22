import { useEffect, useState } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { api } from "../lib/api";
import { toast } from "../store/toast";
import { useTagManagerStore } from "../store/tagManager";
import { usePopover } from "../hooks/usePopover";
import { tagColor } from "../lib/tagColor";
import type { Tag } from "../types";

// Page tag bar: shows the page's tags as chips and a "＋ 添加标签" button that
// opens a popup to pick/create tags, with an inline 标签管理 mode (rename/delete).
export function TagBar({ pageId }: { pageId: string }) {
  const [tags, setTags] = useState<Tag[]>([]);
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [manage, setManage] = useState(false);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editVal, setEditVal] = useState("");
  const { open, pos, triggerRef, contentRef, toggle: togglePop, close } = usePopover<HTMLButtonElement>();

  const load = async () => {
    const [pt, at] = await Promise.all([api.pageTags(pageId), api.listTags()]);
    setTags(pt);
    setAllTags(at);
  };
  useEffect(() => {
    load();
  }, [pageId]);

  const pageTagIds = new Set(tags.map((t) => t.id));
  const q = query.trim().toLowerCase();
  const filtered = allTags.filter((t) => !q || t.name.toLowerCase().includes(q));
  const bump = () => useTagManagerStore.getState().bump();

  const toggle = async (t: Tag) => {
    try {
      if (pageTagIds.has(t.id)) await api.removeTag(pageId, t.id);
      else await api.addTag(pageId, t.name);
      await load();
      bump();
    } catch (e) {
      toast(`操作失败：${e}`, "error");
    }
  };

  const commitInput = async () => {
    const n = query.trim();
    if (!n) return;
    try {
      if (manage) await api.createTag(n);
      else await api.addTag(pageId, n);
      setQuery("");
      await load();
      bump();
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
    const id = editing;
    const n = editVal.trim();
    setEditing(null);
    if (n) {
      try {
        await api.renameTag(id, n);
        await load();
        bump();
      } catch (e) {
        toast(`重命名失败：${e}`, "error");
      }
    }
  };

  const removeGlobal = async (t: Tag) => {
    if (await confirm(`删除标签「${t.name}」？将从 ${t.page_count ?? 0} 个页面移除。`)) {
      try {
        await api.deleteTag(t.id);
        await load();
        bump();
        toast("已删除标签", "success");
      } catch (e) {
        toast(`删除失败：${e}`, "error");
      }
    }
  };

  const removeFromPage = async (t: Tag) => {
    try {
      await api.removeTag(pageId, t.id);
      await load();
      bump();
    } catch (e) {
      toast(`移除失败：${e}`, "error");
    }
  };

  const onAddClick = () => {
    if (open) {
      close();
      return;
    }
    setManage(false);
    setQuery("");
    setEditing(null);
    togglePop();
  };

  const doClose = () => {
    close();
    setManage(false);
    setQuery("");
    setEditing(null);
  };

  return (
    <div className="tag-bar">
      {tags.map((t) => (
        <span key={t.id} className="tag-chip" style={{ background: tagColor(t.name).soft }}>
          <span className="tag-dot" style={{ background: tagColor(t.name).solid }} />
          {t.name}
          <button className="tag-remove" onClick={() => removeFromPage(t)} title="移除标签">
            ×
          </button>
        </span>
      ))}
      <button ref={triggerRef} className="tag-add-trigger" onClick={onAddClick}>
        ＋ 添加标签
      </button>

      {open && (
        <div ref={contentRef} className="tag-picker" style={{ position: "fixed", top: pos.top, left: pos.left }}>
          <div className="tag-picker-head">
            <span className="tag-picker-title">{manage ? "标签管理" : "添加标签"}</span>
            <span className="tag-picker-actions">
              <button className="tag-picker-mode" onClick={() => setManage((m) => !m)}>
                {manage ? "选择" : "管理"}
              </button>
              <button className="tag-picker-close" onClick={doClose} title="关闭">
                ×
              </button>
            </span>
          </div>
          <input
            className="tag-input tag-picker-input"
            placeholder={manage ? "新标签名 / 搜索…" : "搜索或创建标签…"}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitInput();
              }
            }}
            autoFocus
          />
          <div className="tag-picker-list">
            {filtered.map((t) => (
              <div key={t.id} className="tag-picker-row">
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
                  <button className="tag-picker-name" onClick={() => (manage ? startEdit(t) : toggle(t))}>
                    <span className="tag-picker-check">{pageTagIds.has(t.id) ? "✓" : ""}</span>
                    <span className="tag-picker-label">{t.name}</span>
                  </button>
                )}
                {manage && (
                  <>
                    <span className="tag-picker-count">{t.page_count ?? 0} 页</span>
                    <span className="tag-picker-ops">
                      {editing !== t.id && (
                        <button title="重命名" onClick={() => startEdit(t)}>
                          ✎
                        </button>
                      )}
                      <button title="删除标签" onClick={() => removeGlobal(t)}>
                        ×
                      </button>
                    </span>
                  </>
                )}
              </div>
            ))}
            {filtered.length === 0 && (
              <div className="tag-picker-empty">{manage ? "暂无标签" : "无匹配，回车创建并添加"}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
