import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { toast } from "../store/toast";
import { useTagManagerStore } from "../store/tagManager";
import { usePropertyUiStore } from "../store/propertyUi";
import { confirmDialog } from "../store/confirm";
import { tagColor } from "../lib/tagColor";
import type { Tag } from "../types";

function usePageTags(pageId: string) {
  const [tags, setTags] = useState<Tag[]>([]);
  const revision = useTagManagerStore((s) => s.revision);
  const load = async () => {
    try {
      setTags(await api.pageTags(pageId));
    } catch {
      /* ignore */
    }
  };
  useEffect(() => {
    load();
  }, [pageId, revision]);
  return { tags, reload: load, bump: () => useTagManagerStore.getState().bump() };
}

// The page's tags shown as a Notion-style property row (label + chips). Hidden
// when empty; the add button lives in the property-actions footer.
export function TagRow({ pageId }: { pageId: string }) {
  const { tags, reload, bump } = usePageTags(pageId);
  const removeTag = async (t: Tag) => {
    try {
      await api.removeTag(pageId, t.id);
      reload();
      bump();
    } catch (e) {
      toast(`移除失败：${e}`, "error");
    }
  };
  if (tags.length === 0) return null;
  return (
    <div className="prop-row prop-row-tag">
      <span className="prop-name" title="标签">
        标签
      </span>
      <div className="prop-value prop-tag-value">
        {tags.map((t) => (
          <span key={t.id} className="tag-chip" style={{ background: tagColor(t.name, t.color).soft }}>
            <span className="tag-dot" style={{ background: tagColor(t.name, t.color).solid }} />
            {t.name}
            <button className="tag-remove" onClick={() => removeTag(t)} title="移除标签">
              ×
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}

// 预设常用标签色（点在色板里选即可）。
const TAG_PALETTE = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4", "#3b82f6", "#8b5cf6", "#64748b"];

// "＋ 添加标签" button with the picker/manager popup (opened from the actions row).
export function TagAddButton({ pageId }: { pageId: string }) {
  const { tags: pageTags, bump } = usePageTags(pageId);
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [manage, setManage] = useState(false);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editVal, setEditVal] = useState("");
  const [colorOpen, setColorOpen] = useState<string | null>(null);
  const [colorAnchor, setColorAnchor] = useState<{ x: number; y: number } | null>(null);
  const revision = useTagManagerStore((s) => s.revision);
  const tagAnchor = usePropertyUiStore((s) => s.tagAnchor);
  const [open, setOpen] = useState(false);

  const load = async () => {
    try {
      setAllTags(await api.listTags());
    } catch {
      /* ignore */
    }
  };
  // Reload the tag list whenever the global tag revision bumps (rename / delete /
  // create / merge) so an open manager menu reflects the latest tag set.
  useEffect(() => {
    load();
  }, [revision]);

  // "添加标签" from the page-actions row: open the picker (fresh).
  const addTagSeq = usePropertyUiStore((s) => s.addTagSeq);
  useEffect(() => {
    if (addTagSeq > 0) {
      setManage(false);
      setQuery("");
      setEditing(null);
      load();
      setOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addTagSeq]);

  const pageTagIds = new Set(pageTags.map((t) => t.id));
  const q = query.trim().toLowerCase();
  const filtered = allTags.filter((t) => !q || t.name.toLowerCase().includes(q));

  const toggle = async (t: Tag) => {
    try {
      if (pageTagIds.has(t.id)) await api.removeTag(pageId, t.id);
      else await api.addTag(pageId, t.name);
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
        bump();
        toast("已重命名标签", "success");
      } catch (e) {
        toast(`重命名失败：${e}`, "error");
      }
    }
  };
  const removeGlobal = async (t: Tag) => {
    if (await confirmDialog({ title: "删除标签", message: `删除标签「${t.name}」？将从 ${t.page_count ?? 0} 个页面移除。`, danger: true })) {
      try {
        await api.deleteTag(t.id);
        bump();
        toast("已删除标签", "success");
      } catch (e) {
        toast(`删除失败：${e}`, "error");
      }
    }
  };
  // 设置标签自定义颜色（原生颜色选择器）；null = 清空，回退自动配色。
  const setTagColor = async (t: Tag, color: string | null) => {
    try {
      await api.setTagColor(t.id, color);
      bump();
      if (color) toast(`已给「${t.name}」设置颜色`, "success");
    } catch (e) {
      toast(`设置颜色失败：${e}`, "error");
    }
  };

  const doClose = () => {
    setOpen(false);
    setManage(false);
    setQuery("");    setEditing(null);
  };

  // Position the picker next to the "添加标签" action button (below it), clamped
  // to the viewport; flip above when there's no room below.
  const anchor = tagAnchor;
  const PICKER_H = 430;
  const PICKER_W = 316;
  let pickerTop = anchor ? anchor.top + 6 : window.innerHeight / 2 - PICKER_H / 2;
  let pickerLeft = anchor
    ? Math.max(8, Math.min(anchor.left, window.innerWidth - PICKER_W))
    : window.innerWidth / 2 - 150;
  if (anchor && pickerTop + PICKER_H > window.innerHeight - 8) {
    pickerTop = Math.max(8, anchor.top - PICKER_H - 6);
  }

  return (
    <>
      {open && (
        <>
          <div className="tag-picker-backdrop" onClick={() => setOpen(false)} />
          <div
            className="tag-picker"
            style={{
              position: "fixed",
              top: pickerTop,
              left: pickerLeft,
              maxHeight: 420,
              overflowY: "auto",
              zIndex: 70,
            }}
          >
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
                <span className="tag-dot" style={{ background: tagColor(t.name, t.color).solid }} />
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
                      <button
                        className="tag-color-btn"
                        title="设色"
                        onClick={(e) => {
                          setColorOpen((v) => (v === t.id ? null : t.id));
                          setColorAnchor({ x: e.clientX, y: e.clientY });
                        }}
                      >
                        <span className="tag-color-dot" style={{ background: t.color ?? tagColor(t.name).solid }} />
                      </button>
                      {colorOpen === t.id && (
                        <span
                          className="tag-color-palette"
                          style={{ top: colorAnchor?.y ?? 0, left: (colorAnchor?.x ?? 0) - 40 }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {TAG_PALETTE.map((c) => (
                            <button
                              key={c}
                              className="tag-color-pick"
                              style={{ background: c }}
                              title={c}
                              onClick={() => setTagColor(t, c)}
                            />
                          ))}
                          <button className="tag-color-pick tag-color-clear" title="清除颜色" onClick={() => setTagColor(t, null)}>
                            ↺
                          </button>
                        </span>
                      )}
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
        </>
      )}
    </>
  );
}
