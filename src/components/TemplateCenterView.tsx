import { useMemo, useState } from "react";
import { useNotes } from "../store/notes";
import { useTemplateCenterStore } from "../store/templateCenter";
import { TEMPLATES, TEMPLATE_CATEGORIES, type TemplateItem } from "../templates";
import { SearchIcon } from "./icons";

// Template-center gallery (UI skeleton). Templates are hardcoded; clicking a card
// creates a blank page for now — filling template content comes with the backend.
export function TemplateCenterView() {
  const setOpen = useTemplateCenterStore((s) => s.setOpen);
  const { createPage } = useNotes();
  const [tab, setTab] = useState<string>(TEMPLATE_CATEGORIES[0]);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return TEMPLATES.filter(
      (t) =>
        (tab === TEMPLATE_CATEGORIES[0] || t.category === tab) &&
        (!q || t.name.toLowerCase().includes(q) || t.category.toLowerCase().includes(q)),
    );
  }, [tab, query]);

  const useTemplate = async (t: TemplateItem) => {
    // Skeleton: create a blank page; template content fill comes later.
    await createPage(null);
    setOpen(false);
    void t;
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
            <button key={t.id} className="tc-card" onClick={() => useTemplate(t)}>
              <div className="tc-cover" style={{ background: t.cover }}>
                <span className="tc-cover-icon">{t.icon}</span>
              </div>
              <div className="tc-card-body">
                <span className="tc-card-name">{t.name}</span>
                <span className="tc-card-tag">ShuyoNote · 模板</span>
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
