import { useEffect, useMemo, useState } from "react";
import { useNotes } from "../store/notes";
import { useTemplateCenterStore } from "../store/templateCenter";
import { useTemplates } from "../store/templates";
import { TEMPLATES, TEMPLATE_CATEGORIES } from "../templates";
import { SearchIcon } from "./icons";

type GalleryItem = {
  id: string;
  name: string;
  category: string;
  icon: string;
  cover: string;
  content_json: string;
  content_text: string;
  user: boolean;
};

// Deterministic mock "thumbnail" per template: a cover-gradient background with a
// mini white content card (page-screenshot look), until real thumbnails exist.
function MockPreview({ id, cover }: { id: string; cover: string }) {
  let seed = 0;
  for (const ch of id) seed = (seed * 31 + ch.charCodeAt(0)) % 997;
  const lines = 3 + (seed % 2); // 3–4 lines
  const widths = ["72%", "52%", "64%", "45%"];
  const start = seed % widths.length;
  return (
    <div className="tc-preview" style={{ background: cover }}>
      <div className="tc-pv-card">
        <div className="tc-pv-title" />
        <div className="tc-pv-line" style={{ width: widths[start % widths.length] }} />
        <div className="tc-pv-line" style={{ width: widths[(start + 1) % widths.length] }} />
        {Array.from({ length: lines }).map((_, i) => (
          <div
            key={i}
            className="tc-pv-line"
            style={{ width: widths[(start + 2 + i) % widths.length] }}
          />
        ))}
      </div>
    </div>
  );
}

// Template-center gallery: built-in templates (bundled) merged with the user's
// "我的模板" (persisted in DB). Clicking a card creates a page with content.
export function TemplateCenterView() {
  const setOpen = useTemplateCenterStore((s) => s.setOpen);
  const { createPage } = useNotes();
  const userTemplates = useTemplates((s) => s.userTemplates);
  const loadTemplates = useTemplates((s) => s.load);
  const removeTemplate = useTemplates((s) => s.remove);
  const [tab, setTab] = useState<string>(TEMPLATE_CATEGORIES[0]);
  const [query, setQuery] = useState("");

  useEffect(() => {
    loadTemplates();
  }, [loadTemplates]);

  const all: GalleryItem[] = useMemo(() => {
    const built = TEMPLATES.map((t) => ({
      id: t.id, name: t.name, category: t.category, icon: t.icon, cover: t.cover,
      content_json: t.content_json, content_text: t.content_text, user: false,
    }));
    const user = userTemplates.map((t) => ({
      id: t.id, name: t.name, category: t.category, icon: t.icon, cover: t.cover,
      content_json: t.content_json, content_text: t.content_text, user: true,
    }));
    return [...built, ...user];
  }, [userTemplates]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter(
      (t) =>
        (tab === TEMPLATE_CATEGORIES[0] || t.category === tab) &&
        (!q || t.name.toLowerCase().includes(q) || t.category.toLowerCase().includes(q)),
    );
  }, [all, tab, query]);

  const useTemplate = async (t: GalleryItem) => {
    await createPage(null, { content_json: t.content_json, content_text: t.content_text });
    setOpen(false);
  };

  return (
    <div className="template-center">
      <div className="tc-head">
        <div className="tc-breadcrumb">
          <span className="tc-crumb">模板中心</span>
          <span className="tc-crumb-sep">/</span>
          <span className="tc-crumb-current">{tab}</span>
        </div>
        <div className="tc-search">
          <SearchIcon className="tc-search-icon" />
          <input
            className="tc-search-input"
            placeholder="搜索模板库…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <button className="tc-close" title="关闭" onClick={() => setOpen(false)}>
          ×
        </button>
      </div>
      <div className="tc-tabs">
        {TEMPLATE_CATEGORIES.map((c) => (
          <button
            key={c}
            className={`tc-tab ${tab === c ? "tc-tab-active" : ""}`}
            onClick={() => setTab(c)}
          >
            {c}
          </button>
        ))}
      </div>
      <div className="tc-grid">
        {filtered.length === 0 ? (
          <div className="tc-empty">
            {tab === "我的模板" ? "暂无我的模板 · 保存页面为模板后出现在这里" : "没有匹配的模板"}
          </div>
        ) : (
          filtered.map((t) => (
            <div key={t.id} className="tc-card" onClick={() => useTemplate(t)}>
              {t.user && (
                <button
                  className="tc-card-del"
                  title="删除模板"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeTemplate(t.id);
                  }}
                >
                  ×
                </button>
              )}
              <MockPreview id={t.id} cover={t.cover} />
              <div className="tc-card-body">
                <span className="tc-card-name">{t.name}</span>
                <span className="tc-card-tag">
                  {t.user ? "我的模板" : "ShuyoNote · 模板"}
                </span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
