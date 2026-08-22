import { useMemo, useState } from "react";
import { useNotes } from "../store/notes";
import { useTemplateCenterStore } from "../store/templateCenter";
import { TEMPLATES, TEMPLATE_CATEGORIES, type TemplateItem } from "../templates";
import { SearchIcon } from "./icons";

// Deterministic mock "thumbnail" per template: a cover-gradient background with a
// mini white content card (page-screenshot look) at the top of the card, until
// real template thumbnails exist.
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
    // Seed a real page with the template's Lexical content (not a blank page).
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
            <button key={t.id} className="tc-card" onClick={() => useTemplate(t)}>
              <MockPreview id={t.id} cover={t.cover} />
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
